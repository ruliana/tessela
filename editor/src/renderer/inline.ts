// A block of Markdown drawn as text with its tags, links and emphasis, outside the editor.

import { inlineParts } from "../shared/inline";
import { el } from "./dom";

/** `openDay` makes the dates in the text buttons that open that day's journal. */
export function renderInlineText(text: string, openDay?: (day: string) => void): (Node | string)[] {
  return inlineParts(text).map((part) => {
    switch (part.kind) {
      case "text":
        return part.text;
      case "date":
        if (!openDay) return part.text;
        return el(
          "span",
          {
            class: "date",
            title: `Open ${part.day}`,
            // The block around it opens its own page: a date opens a day instead.
            onclick: (event: MouseEvent) => {
              event.stopPropagation();
              openDay(part.day);
            },
          },
          part.text,
        );
      case "tag":
        return el("span", { class: "tag" }, part.text);
      case "link":
        return el("span", { class: "lnk", title: part.dest }, part.text);
      case "code":
        return el("code", {}, part.text);
      case "bold":
        return el("strong", {}, part.text);
      case "italic":
        return el("em", {}, part.text);
      case "strike":
        return el("del", {}, part.text);
    }
  });
}
