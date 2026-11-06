//! Oracle Database through ODPI-C (the `oracle` crate), which loads the Oracle Client
//! libraries (Instant Client) at run time. Calls block, so they run on the blocking pool;
//! a statement is stopped with `break_execution` from another thread.

use crate::conn::{QueryResult, ResultColumn, Setup};
use crate::source::DataSource;
use ide_core::{CancellationToken, IdeError, IdeResult, error::ErrorKind};
use oracle::sql_type::OracleType;
use parking_lot::Mutex;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Instant;

pub(crate) const DEFAULT_PORT: u16 = 1521;
/// Connections kept for reuse; more are opened when all are busy.
const IDLE_MAX: usize = 4;

/// Shared so that another thread can `break_execution` while a statement runs.
type Conn = Arc<oracle::Connection>;

/// Auto-commit is set on connections nobody else holds (in the pool, or just taken out).
fn set_autocommit(conn: &mut Conn, on: bool) {
    let unique = Arc::get_mut(conn).map(|c| c.set_autocommit(on));
    debug_assert!(unique.is_some(), "auto-commit changed on a shared Oracle connection");
}

pub(crate) fn ora_err(e: oracle::Error) -> IdeError {
    if let Some(db) = e.db_error() {
        // ORA-01017 invalid username/password, ORA-28000 account locked, ORA-01045 no CREATE SESSION.
        let auth = matches!(db.code(), 1017 | 28000 | 1045);
        let kind = if auth { ErrorKind::PermissionDenied } else { ErrorKind::InvalidInput };
        return IdeError::new(kind, db.message().trim_end().to_owned());
    }
    let text = e.to_string();
    // DPI-1047: no Oracle Client library on the library path.
    if text.contains("DPI-1047") {
        return IdeError::new(
            ErrorKind::Unavailable,
            format!(
                "Oracle Instant Client was not found. Install it (Basic or Basic Light package) and add its \
                 folder to LD_LIBRARY_PATH or /etc/ld.so.conf.d, then restart the IDE.\n{text}"
            ),
        );
    }
    IdeError::new(ErrorKind::Io, text)
}

fn join_err(e: tokio::task::JoinError) -> IdeError {
    IdeError::internal(e.to_string())
}

/// The connect string: EZConnect `//host:port/service` from the data source's host, port and
/// database (the service name), or the database field as it is (a TNS alias, a full
/// descriptor or an EZConnect string) when no host is set.
pub(crate) fn connect_string(source: &DataSource) -> String {
    let host = source.host.trim();
    let database = source.database.trim();
    if host.is_empty() {
        return database.to_owned();
    }
    let port = source.port.unwrap_or(DEFAULT_PORT);
    if database.is_empty() { format!("//{host}:{port}") } else { format!("//{host}:{port}/{database}") }
}

struct Params {
    user: String,
    password: String,
    connect_string: String,
    /// `CURRENT_SCHEMA` of every session.
    schema: Option<String>,
    statements: Vec<String>,
}

struct Inner {
    params: Params,
    idle: Mutex<Vec<Conn>>,
    closed: AtomicBool,
}

#[derive(Clone)]
pub struct OraclePool(Arc<Inner>);

impl OraclePool {
    /// Opens one connection (so bad settings fail here) and keeps it for reuse.
    pub(crate) async fn connect(source: &DataSource, password: Option<&str>, setup: Setup) -> IdeResult<Self> {
        let mut statements = Vec::new();
        let tz = source.options.time_zone.trim();
        if !tz.is_empty() {
            statements.push(format!("ALTER SESSION SET TIME_ZONE = {}", crate::sql::quote_literal(source.driver, tz)));
        }
        statements.extend(setup.statements);
        let schema = Some(source.options.default_schema.trim().to_owned()).filter(|s| !s.is_empty());
        let pool = OraclePool(Arc::new(Inner {
            params: Params {
                user: source.user.clone(),
                password: password.unwrap_or_default().to_owned(),
                connect_string: connect_string(source),
                schema,
                statements,
            },
            idle: Mutex::new(Vec::new()),
            closed: AtomicBool::new(false),
        }));
        let conn = pool.open().await?;
        pool.release(conn);
        Ok(pool)
    }

    async fn open(&self) -> IdeResult<Conn> {
        let inner = self.0.clone();
        tokio::task::spawn_blocking(move || {
            let p = &inner.params;
            let mut conn =
                oracle::Connector::new(&p.user, &p.password, &p.connect_string).connect().map_err(ora_err)?;
            conn.set_autocommit(true);
            if let Some(schema) = &p.schema {
                conn.set_current_schema(schema).map_err(ora_err)?;
            }
            for sql in &p.statements {
                conn.execute(executable(sql), &[]).map_err(ora_err)?;
            }
            Ok(Arc::new(conn))
        })
        .await
        .map_err(join_err)?
    }

    /// An idle connection, or a new one.
    pub async fn acquire(&self) -> IdeResult<Conn> {
        if self.is_closed() {
            return Err(IdeError::new(ErrorKind::Io, "Oracle connection is closed"));
        }
        let idle = self.0.idle.lock().pop();
        match idle {
            Some(conn) => Ok(conn),
            None => self.open().await,
        }
    }

    /// Returns `conn` for reuse (in auto-commit mode), or closes it.
    pub fn release(&self, mut conn: Conn) {
        set_autocommit(&mut conn, true);
        let mut idle = self.0.idle.lock();
        if self.is_closed() || idle.len() >= IDLE_MAX {
            drop(idle);
            let _ = conn.close();
        } else {
            idle.push(conn);
        }
    }

    pub fn close(&self) {
        self.0.closed.store(true, Ordering::Release);
        for conn in self.0.idle.lock().drain(..) {
            let _ = conn.close();
        }
    }

    pub fn is_closed(&self) -> bool {
        self.0.closed.load(Ordering::Acquire)
    }

    /// Runs `sql` for introspection (cells as text, at most `max` rows).
    pub async fn rows(&self, sql: &str, max: usize) -> IdeResult<Vec<Vec<Option<String>>>> {
        let conn = self.acquire().await?;
        let (conn, r) = run(conn, sql.to_owned(), 0, max, &CancellationToken::new()).await;
        if let Some(conn) = conn {
            self.release(conn);
        }
        Ok(r?.rows)
    }

    pub async fn execute_from(
        &self,
        sql: &str,
        skip: usize,
        max_rows: usize,
        cancel: &CancellationToken,
    ) -> IdeResult<QueryResult> {
        let conn = self.acquire().await?;
        let (conn, r) = run(conn, sql.to_owned(), skip, max_rows, cancel).await;
        if let Some(conn) = conn {
            self.release(conn);
        }
        r
    }

    /// `EXPLAIN PLAN` of `statement`, read back from the session's `PLAN_TABLE` on the same connection.
    pub async fn explain(&self, statement: &str, cancel: &CancellationToken) -> IdeResult<QueryResult> {
        let explain = crate::plan::explain_statement(crate::DbDriver::Oracle, statement);
        let conn = self.acquire().await?;
        let (conn, explained) = run(conn, explain, 0, 0, cancel).await;
        let Some(conn) = conn else { return explained };
        if let Err(e) = explained {
            self.release(conn);
            return Err(e);
        }
        let (conn, plan) = run(conn, crate::plan::ORACLE_PLAN.to_owned(), 0, 10_000, cancel).await;
        if let Some(conn) = conn {
            let cleanup = format!("DELETE FROM plan_table WHERE statement_id = '{}'", crate::plan::ORACLE_PLAN_ID);
            let (conn, _) = run(conn, cleanup, 0, 0, cancel).await;
            if let Some(conn) = conn {
                self.release(conn);
            }
        }
        plan
    }

    /// Runs `statements` in one transaction (table editor submits).
    pub async fn transaction(&self, statements: &[(String, bool)]) -> IdeResult<u64> {
        let mut conn = self.acquire().await?;
        set_autocommit(&mut conn, false);
        let statements = statements.to_vec();
        let (conn, result) = tokio::task::spawn_blocking(move || {
            let result = (|| {
                let mut total = 0;
                for (sql, expect_one) in &statements {
                    let n = conn.execute(executable(sql), &[]).map_err(ora_err)?.row_count().map_err(ora_err)?;
                    if *expect_one && n != 1 {
                        return Err(IdeError::invalid(format!(
                            "{sql}: expected to change 1 row, changed {n}; nothing was saved"
                        )));
                    }
                    total += n;
                }
                conn.commit().map_err(ora_err)?;
                Ok(total)
            })();
            if result.is_err() && conn.rollback().is_err() {
                // Never return a connection with an open transaction to the pool.
                let _ = conn.close();
                return (None, result);
            }
            (Some(conn), result)
        })
        .await
        .map_err(join_err)?;
        if let Some(conn) = conn {
            self.release(conn);
        }
        result
    }
}

/// A connection held by a manual-commit console: auto-commit off, its transaction open
/// until [`Held::command`](crate::conn::Held::command) commits or rolls it back.
pub struct HeldOracle {
    pub(crate) pool: OraclePool,
    pub(crate) conn: Option<Conn>,
}

impl HeldOracle {
    pub async fn acquire(pool: &OraclePool) -> IdeResult<Self> {
        let mut conn = pool.acquire().await?;
        set_autocommit(&mut conn, false);
        Ok(HeldOracle { pool: pool.clone(), conn: Some(conn) })
    }

    /// `COMMIT` / `ROLLBACK` end the transaction; `BEGIN` has nothing to do (Oracle starts
    /// one with the first change).
    pub async fn command(&mut self, sql: &str) -> IdeResult<()> {
        let conn = self.conn.clone().ok_or_else(|| IdeError::new(ErrorKind::Io, "Oracle connection is closed"))?;
        let sql = sql.trim().to_owned();
        tokio::task::spawn_blocking(move || match sql.to_ascii_uppercase().as_str() {
            "COMMIT" => conn.commit().map_err(ora_err),
            "ROLLBACK" => conn.rollback().map_err(ora_err),
            "" | "BEGIN" => Ok(()),
            _ => conn.execute(executable(&sql), &[]).map(drop).map_err(ora_err),
        })
        .await
        .map_err(join_err)?
    }

    pub async fn execute_from(
        &mut self,
        sql: &str,
        skip: usize,
        max_rows: usize,
        cancel: &CancellationToken,
    ) -> IdeResult<QueryResult> {
        let conn = self.conn.take().ok_or_else(|| IdeError::new(ErrorKind::Io, "Oracle connection is closed"))?;
        let (conn, r) = run(conn, sql.to_owned(), skip, max_rows, cancel).await;
        self.conn = conn;
        r
    }

    /// Closes the connection; the server rolls its transaction back.
    pub fn discard(mut self) {
        if let Some(conn) = self.conn.take() {
            let _ = conn.close();
        }
    }
}

impl Drop for HeldOracle {
    fn drop(&mut self) {
        if let Some(conn) = self.conn.take() {
            // Nothing left open may reach the pool, where auto-commit would commit it.
            if conn.rollback().is_ok() {
                self.pool.release(conn);
            } else {
                let _ = conn.close();
            }
        }
    }
}

/// Oracle rejects the `;` that ends a SQL statement, but a PL/SQL block needs its own.
fn executable(sql: &str) -> &str {
    let sql = sql.trim();
    if crate::split::starts_plsql(sql) { sql } else { sql.trim_end_matches(';').trim_end() }
}

/// Runs one statement on `conn`, stopping it on the server when `cancel` fires.
/// Gives the connection back unless the statement was interrupted.
async fn run(
    conn: Conn,
    sql: String,
    skip: usize,
    max: usize,
    cancel: &CancellationToken,
) -> (Option<Conn>, IdeResult<QueryResult>) {
    let breaker = conn.clone();
    let mut task = tokio::task::spawn_blocking(move || {
        let r = fetch(&conn, &sql, skip, max);
        (conn, r)
    });
    let joined = tokio::select! {
        j = &mut task => j,
        () = cancel.cancelled() => {
            let _ = breaker.break_execution();
            let _ = task.await;
            let _ = breaker.close();
            return (None, Err(IdeError::cancelled()));
        }
    };
    match joined {
        Ok((conn, r)) => (Some(conn), r),
        Err(e) => (None, Err(join_err(e))),
    }
}

fn fetch(conn: &oracle::Connection, sql: &str, skip: usize, max: usize) -> IdeResult<QueryResult> {
    let started = Instant::now();
    let text = executable(sql);
    let mut stmt = conn.statement(text).fetch_array_size(256).build().map_err(ora_err)?;
    let mut columns = Vec::new();
    let mut rows = Vec::new();
    let mut has_more = false;
    let mut affected = None;
    let first;
    if stmt.is_query() {
        let result = stmt.query(&[]).map_err(ora_err)?;
        first = Instant::now();
        columns = result
            .column_info()
            .iter()
            .map(|c| ResultColumn { name: c.name().to_owned(), type_name: c.oracle_type().to_string() })
            .collect();
        let mut to_skip = skip;
        for row in result {
            let row = row.map_err(ora_err)?;
            if to_skip > 0 {
                to_skip -= 1;
                continue;
            }
            if rows.len() >= max {
                has_more = true;
                break;
            }
            rows.push(row.sql_values().iter().map(cell).collect());
        }
    } else {
        stmt.execute(&[]).map_err(ora_err)?;
        first = Instant::now();
        affected = Some(stmt.row_count().map_err(ora_err)? as f64);
    }
    let elapsed_ms = started.elapsed().as_secs_f64() * 1000.0;
    Ok(QueryResult {
        statement: sql.to_owned(),
        affected: if columns.is_empty() { Some(affected.unwrap_or(0.0)) } else { None },
        columns,
        rows,
        has_more,
        elapsed_ms,
        execution_ms: first.duration_since(started).as_secs_f64() * 1000.0,
    })
}

fn cell(v: &oracle::SqlValue) -> Option<String> {
    if v.is_null().unwrap_or(false) {
        return None;
    }
    let binary = matches!(v.oracle_type(), Ok(OracleType::Raw(_) | OracleType::BLOB | OracleType::LongRaw));
    if binary {
        return v.get::<Vec<u8>>().ok().map(|b| {
            let mut s = String::with_capacity(2 + b.len() * 2);
            s.push_str("0x");
            for byte in b {
                s.push_str(&format!("{byte:02X}"));
            }
            s
        });
    }
    Some(v.get::<String>().unwrap_or_else(|_| format!("{v}")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::source::DbDriver;

    fn source(host: &str, port: Option<u16>, database: &str) -> DataSource {
        DataSource {
            driver: DbDriver::Oracle,
            host: host.into(),
            port,
            database: database.into(),
            ..DataSource::default()
        }
    }

    #[test]
    fn connect_strings() {
        assert_eq!(connect_string(&source("db.local", None, "FREEPDB1")), "//db.local:1521/FREEPDB1");
        assert_eq!(connect_string(&source("db.local", Some(1600), "")), "//db.local:1600");
        assert_eq!(connect_string(&source("", None, "PROD_TNS")), "PROD_TNS");
    }

    #[test]
    fn statements_lose_their_semicolon_but_blocks_keep_it() {
        assert_eq!(executable("select 1 from dual;"), "select 1 from dual");
        assert_eq!(executable("begin null; end;"), "begin null; end;");
        assert_eq!(
            executable("create or replace procedure p is begin null; end;"),
            "create or replace procedure p is begin null; end;"
        );
    }
}
