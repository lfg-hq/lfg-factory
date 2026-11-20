// Vendor bundle for the in-place document editor (public/js/doc-editor.js).
// Rebuild with: bun install && bun run build  → public/js/vendor/doc-editor.js
import { Editor, Extension } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { Markdown } from "@tiptap/markdown";
import { TableKit } from "@tiptap/extension-table";
import { TaskList, TaskItem } from "@tiptap/extension-list";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

window.LfgTiptap = { Editor, Extension, StarterKit, Markdown, TableKit, TaskList, TaskItem, Plugin, PluginKey, Decoration, DecorationSet };
