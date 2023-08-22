import * as html from "/core/unlit.js";
import { css } from "../third-party/lit.js";
import Panel from "./panel.js";

export default class GlyphSearchPanel extends Panel {
  identifier = "glyph-search";
  iconPath = "/images/magnifyingglass.svg";

  static styles = css`
    .glyph-search {
      box-sizing: border-box;
      height: 100%;
      width: 100%;
      display: grid;
      gap: 1em;
      padding: 1em;
    }
  `;

  getContentElement() {
    return html.div(
      {
        class: "glyph-search",
      },
      [
        html.createDomElement("glyphs-search", {
          id: "glyphs-search",
        }),
      ]
    );
  }
}

customElements.define("panel-glyph-search", GlyphSearchPanel);
