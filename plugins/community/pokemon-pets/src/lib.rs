//! Pokémon Pets for OpenIDEA: Pokémon walk around a tool window, as in vscode-pokemon.
//!
//! The page (an `html` body) animates the pets and keeps their state. Its frame has no
//! network, so the plugin fetches what it shows: a Pokémon's animated sprite from the
//! public PokeAPI sprites repository (sent to the page as a `data:` URL, cached in the
//! plugin's storage) and the list of names (from PokeAPI, cached too). The state the page
//! saves — which pets, their size, speed and scene — survives restarts in the storage.

use base64::Engine;
use openidea_plugin::host;
use openidea_plugin::views::{Body, View, ViewEvent, Viewport, Views};
use openidea_plugin::{Error, HttpRequest, Invocation, Plugin, register_plugin};
use serde_json::{Value, json};

pub const VIEW: &str = "pets";
const PAGE: &str = include_str!("page.html");
/// Pokémon with animated sprites (generations I–V); later ones get a still image.
pub const ANIMATED: u32 = 649;
/// The highest Pokédex number offered.
pub const LAST: u32 = 1025;
const STATE_KEY: &str = "state";
const NAMES_KEY: &str = "names";
/// Larger sprites than this are refused (they are a few KiB).
const MAX_SPRITE: usize = 1 << 20;

#[derive(Default)]
pub struct PokemonPets;

/// Where Pokémon `id`'s sprite is: animated when there is one, else the still front image.
pub fn sprite_url(id: u32) -> String {
    const BASE: &str = "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon";
    if id <= ANIMATED {
        format!("{BASE}/versions/generation-v/black-white/animated/{id}.gif")
    } else {
        format!("{BASE}/{id}.png")
    }
}

/// The first pet, and the defaults the page starts from.
pub fn default_state() -> Value {
    json!({ "pets": [{ "id": 25 }], "size": 1.0, "speed": 1.0, "scene": "none" })
}

fn post(message: &Value) -> Result<(), Error> {
    host::post_view_message(VIEW, &message.to_string())
}

/// Pokémon `id`'s sprite as a `data:` URL, from the storage or else fetched (and kept).
pub fn sprite(id: u32) -> Result<String, Error> {
    if id == 0 || id > LAST {
        return Err(Error::Invalid(format!("no Pokémon #{id}")));
    }
    let key = format!("sprite:{id}");
    if let Some(url) = host::storage::get(&key)? {
        return Ok(url);
    }
    let response = host::fetch(&HttpRequest { timeout_ms: Some(20_000), ..HttpRequest::get(&sprite_url(id)) })?;
    if response.status != 200 || response.body.is_empty() || response.body.len() > MAX_SPRITE {
        return Err(Error::Failed(format!("the sprite of #{id} could not be loaded ({})", response.status)));
    }
    let mime = if id <= ANIMATED { "image/gif" } else { "image/png" };
    let url = format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(&response.body));
    host::storage::set(&key, &url)?;
    Ok(url)
}

/// The Pokémon's names in Pokédex order (index 0 is #1), from the storage or else PokeAPI.
pub fn names() -> Result<Vec<String>, Error> {
    if let Some(saved) = host::storage::get(NAMES_KEY)?
        && let Ok(list) = serde_json::from_str::<Vec<String>>(&saved)
        && !list.is_empty()
    {
        return Ok(list);
    }
    let url = format!("https://pokeapi.co/api/v2/pokemon-species?limit={LAST}");
    let response = host::fetch(&HttpRequest { timeout_ms: Some(20_000), ..HttpRequest::get(&url) })?;
    if response.status != 200 {
        return Err(Error::Failed(format!("the list of Pokémon could not be loaded ({})", response.status)));
    }
    let list = parse_names(&response.text())?;
    host::storage::set(NAMES_KEY, &serde_json::to_string(&list).unwrap_or_default())?;
    Ok(list)
}

/// PokeAPI's species list (`results[].url` ends in the Pokédex number) as names by number.
pub fn parse_names(body: &str) -> Result<Vec<String>, Error> {
    let v: Value = serde_json::from_str(body).map_err(|e| Error::Failed(format!("bad list of Pokémon: {e}")))?;
    let mut by_id: Vec<(u32, String)> = v
        .get("results")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|r| {
            let name = r.get("name")?.as_str()?.to_owned();
            let id = r.get("url")?.as_str()?.trim_end_matches('/').rsplit('/').next()?.parse().ok()?;
            Some((id, name))
        })
        .filter(|(id, _)| (1..=LAST).contains(id))
        .collect();
    by_id.sort();
    let mut names = Vec::new();
    for (id, name) in by_id {
        // Pokédex order with no gaps: a missing number keeps its place.
        while names.len() + 1 < id as usize {
            names.push(format!("#{}", names.len() + 1));
        }
        names.push(name);
    }
    if names.is_empty() {
        return Err(Error::Failed("the list of Pokémon is empty".into()));
    }
    Ok(names)
}

/// Answers one message of the page.
pub fn answer(message: &Value) -> Result<(), Error> {
    match message.get("op").and_then(Value::as_str) {
        Some("ready") => {
            let state = host::storage::get(STATE_KEY)?
                .and_then(|s| serde_json::from_str::<Value>(&s).ok())
                .filter(Value::is_object)
                .unwrap_or_else(default_state);
            post(&json!({ "op": "state", "state": state, "animated": ANIMATED, "last": LAST }))
        }
        Some("save") => match message.get("state").filter(|s| s.is_object()) {
            Some(state) => host::storage::set(STATE_KEY, &state.to_string()),
            None => Ok(()),
        },
        Some("sprite") => {
            let id = message.get("id").and_then(Value::as_u64).unwrap_or(0) as u32;
            match sprite(id) {
                Ok(url) => post(&json!({ "op": "sprite", "id": id, "url": url })),
                Err(e) => post(&json!({ "op": "sprite", "id": id, "error": e.to_string() })),
            }
        }
        Some("names") => match names() {
            Ok(list) => post(&json!({ "op": "names", "names": list })),
            Err(e) => post(&json!({ "op": "names", "error": e.to_string() })),
        },
        _ => Ok(()),
    }
}

impl Plugin for PokemonPets {
    fn run_command(&mut self, id: &str, _ctx: &Invocation, _arg: Option<&str>) -> Result<Option<String>, Error> {
        let op = match id {
            "add-random" => "add-random",
            "clear" => "clear",
            _ => return Err(Error::NotFound(format!("command {id}"))),
        };
        // Shown first: the page acts on the message once it has loaded.
        host::reveal_view(VIEW)?;
        post(&json!({ "op": op })).map(|()| None)
    }
}

impl Views for PokemonPets {
    fn render(&mut self, view: &str, _viewport: Option<Viewport>, _ctx: &Invocation) -> Result<View, Error> {
        if view != VIEW {
            return Err(Error::NotFound(view.into()));
        }
        // The page keeps its own state and asks for it when it loads: the plugin only
        // answers, and never renders it again (that would reload the frame).
        Ok(View::new(Body::Html(PAGE.to_owned())))
    }

    fn handle(&mut self, view: &str, event: ViewEvent, _ctx: &Invocation) -> Result<(), Error> {
        if view != VIEW {
            return Err(Error::NotFound(view.into()));
        }
        match event {
            ViewEvent::Message(text) => match serde_json::from_str::<Value>(&text) {
                Ok(message) => answer(&message),
                Err(_) => Ok(()),
            },
            _ => Ok(()),
        }
    }
}

register_plugin!(PokemonPets, views);

#[cfg(test)]
mod tests {
    use super::*;
    use openidea_plugin::HttpResponse;
    use openidea_plugin::mock::MockHost;

    const CAPS: &[&str] = &["storage", "net:raw.githubusercontent.com", "net:pokeapi.co"];

    fn messages(host: &MockHost) -> Vec<Value> {
        host.view_messages().into_iter().map(|(_, m)| serde_json::from_str(&m).unwrap()).collect()
    }

    #[test]
    fn sprites_are_animated_up_to_generation_five() {
        assert!(sprite_url(25).ends_with("/generation-v/black-white/animated/25.gif"));
        assert!(sprite_url(650).ends_with("/sprites/pokemon/650.png"));
    }

    #[test]
    fn starts_with_pikachu_and_keeps_what_the_page_saves() {
        let host = MockHost::install().with_capabilities(CAPS);
        answer(&json!({ "op": "ready" })).unwrap();
        assert_eq!(messages(&host)[0]["state"], default_state());
        let state = json!({ "pets": [{ "id": 1 }, { "id": 4 }], "size": 1.5, "speed": 2.0, "scene": "grass" });
        answer(&json!({ "op": "save", "state": state })).unwrap();
        answer(&json!({ "op": "ready" })).unwrap();
        assert_eq!(messages(&host)[1]["state"], state);
    }

    #[test]
    fn a_sprite_is_fetched_once_and_sent_as_a_data_url() {
        let host = MockHost::install().with_capabilities(CAPS);
        let calls = std::rc::Rc::new(std::cell::Cell::new(0));
        let counted = calls.clone();
        host.on_fetch(move |req| {
            counted.set(counted.get() + 1);
            assert!(req.url.ends_with("/animated/25.gif"), "{}", req.url);
            Ok(HttpResponse { status: 200, headers: vec![], body: b"GIF89a".to_vec() })
        });
        answer(&json!({ "op": "sprite", "id": 25 })).unwrap();
        answer(&json!({ "op": "sprite", "id": 25 })).unwrap();
        let sent = messages(&host);
        assert_eq!(sent[0]["url"], "data:image/gif;base64,R0lGODlh");
        assert_eq!(sent[1]["url"], sent[0]["url"]);
        assert_eq!(calls.get(), 1, "the second one comes from the storage");
        answer(&json!({ "op": "sprite", "id": 0 })).unwrap();
        assert!(messages(&host)[2]["error"].as_str().unwrap().contains("#0"));
    }

    #[test]
    fn names_follow_the_pokedex_order() {
        let body = r#"{"results": [
            {"name": "ivysaur", "url": "https://pokeapi.co/api/v2/pokemon-species/2/"},
            {"name": "bulbasaur", "url": "https://pokeapi.co/api/v2/pokemon-species/1/"},
            {"name": "charmander", "url": "https://pokeapi.co/api/v2/pokemon-species/4/"}
        ]}"#;
        assert_eq!(parse_names(body).unwrap(), ["bulbasaur", "ivysaur", "#3", "charmander"]);
        assert!(parse_names(r#"{"results": []}"#).is_err());
    }
}
