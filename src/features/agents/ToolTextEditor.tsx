/** The editor tab of a command's IN or OUT: read-only, with the editor's font, numbers and highlighting. */
import { useEffect, useRef } from "react";
import { EditorState, StateEffect } from "@codemirror/state";
import { EditorView, highlightSpecialChars } from "@codemirror/view";
import { syntaxHighlighting } from "@codemirror/language";
import { findExtension } from "@/editor/core/cm/find";
import { openideaHighlightStyle } from "@/editor/core/cm/highlight";
import { findLanguageDescription, loadSupport } from "@/editor/core/cm/languages";
import { fontExtension, lineNumbersExtension } from "@/editor/core/cm/setup";
import { openideaTheme } from "@/editor/core/cm/theme";
import { useProject } from "@/platform/project";
import type { EditorInput } from "@/workbench/contributions";
import type { ToolTextData } from "./toolText";
import styles from "./ToolTextEditor.module.css";

export function ToolTextEditor({ input }: { input: EditorInput }) {
  const data = input.data as ToolTextData;
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const parent = host.current;
    if (!parent) return;
    const settings = useProject.getState().settings?.editor;
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: data.text,
        extensions: [
          fontExtension(settings),
          lineNumbersExtension(settings),
          EditorState.readOnly.of(true),
          openideaTheme,
          highlightSpecialChars(),
          syntaxHighlighting(openideaHighlightStyle),
          findExtension(),
          EditorView.lineWrapping,
          EditorView.contentAttributes.of({ "aria-label": data.title }),
        ],
      }),
    });
    let alive = true;
    const language = findLanguageDescription(null, data.fileName);
    if (language) {
      void loadSupport(language).then((support) => {
        if (alive && support) view.dispatch({ effects: StateEffect.appendConfig.of(support) });
      });
    }
    return () => {
      alive = false;
      view.destroy();
    };
  }, [data.text, data.title, data.fileName]);
  return <div ref={host} className={styles.editor} />;
}
