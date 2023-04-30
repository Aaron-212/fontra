import * as html from "/core/unlit.js";
import { UnlitElement } from "/core/unlit.js";
import { getCharFromUnicode, makeUPlusStringFromCodePoint } from "/core/utils.js";
import { themeColorCSS } from "./theme-support.js";
import { UIList } from "./ui-list.js";

const colors = {
  "search-input-foreground-color": ["black", "white"],
  "search-input-background-color": ["#eee", "#333"],
};

export class GlyphsSearch extends UnlitElement {
  static styles = `
    ${themeColorCSS(colors)}

    :host {
      display: grid;
      gap: 1em;
      grid-template-rows: auto 1fr;
      box-sizing: border-box;
      overflow: hidden;
      align-content: start;
    }

    input {
      color: var(--search-input-foreground-color);
      background-color: var(--search-input-background-color);
      font-family: fontra-ui-regular, sans-serif;
      font-size: 1.1rem;
      border-radius: 2em;
      border: none;
      outline: none;
      resize: none;
      width: 100%;
      height: 1.8em;
      box-sizing: border-box;
      padding: 0.2em 0.8em;
    }
  `;

  constructor() {
    super();

    this.searchField = html.input({
      type: "text",
      placeholder: "Search glyphs",
      autocomplete: "off",
      oninput: (event) => this._searchFieldChanged(event),
    });

    const columnDescriptions = [
      {
        key: "char",
        width: "2em",
        get: (item) => getCharFromUnicode(item.unicodes[0]),
      },
      { key: "glyphName", width: "10em", isIdentifierKey: true },
      {
        key: "unicode",
        width: "5em",
        get: (item) => makeUPlusStringFromCodePoint(item.unicodes[0]),
      },
    ];
    this.glyphNamesList = new UIList();
    this.glyphNamesList.columnDescriptions = columnDescriptions;

    this.glyphNamesList.addEventListener("listSelectionChanged", () => {
      const event = new CustomEvent("selectedGlyphNameChanged", {
        bubbles: false,
        detail: this.getSelectedGlyphName(),
      });
      this.dispatchEvent(event);
    });

    this.glyphNamesList.addEventListener("rowDoubleClicked", () => {
      const event = new CustomEvent("selectedGlyphNameDoubleClicked", {
        bubbles: false,
        detail: this.getSelectedGlyphName(),
      });
      this.dispatchEvent(event);
    });

    this._glyphNamesListFilterFunc = (item) => true; // pass all through

    this.glyphMap = {};
  }

  focusSearchField() {
    this.searchField.focus();
  }

  render() {
    return [this.searchField, this.glyphNamesList];
  }

  get glyphMap() {
    return this._glyphMap;
  }

  set glyphMap(glyphMap) {
    this._glyphMap = glyphMap;
    this.updateGlyphNamesListContent();
  }

  getSelectedGlyphName() {
    return this.glyphNamesList.items[this.glyphNamesList.selectedItemIndex]?.glyphName;
  }

  updateGlyphNamesListContent() {
    const glyphMap = this.glyphMap;
    this.glyphsListItems = [];
    for (const glyphName in glyphMap) {
      this.glyphsListItems.push({
        glyphName: glyphName,
        unicodes: glyphMap[glyphName],
      });
    }
    this.glyphsListItems.sort(glyphItemSortFunc);
    this._setFilteredGlyphNamesListContent();
  }

  _searchFieldChanged(event) {
    const value = event.target.value;
    const searchItems = value.split(/\s+/).filter((item) => item.length);
    this._glyphNamesListFilterFunc = (item) => glyphFilterFunc(item, searchItems);
    this._setFilteredGlyphNamesListContent();
  }

  _setFilteredGlyphNamesListContent() {
    const filteredGlyphItems = this.glyphsListItems.filter(
      this._glyphNamesListFilterFunc
    );
    this.glyphNamesList.setItems(filteredGlyphItems);
  }
}

customElements.define("glyphs-search", GlyphsSearch);

function glyphItemSortFunc(item1, item2) {
  const uniCmp = compare(item1.unicodes[0], item2.unicodes[0]);
  const glyphNameCmp = compare(item1.glyphName, item2.glyphName);
  return uniCmp ? uniCmp : glyphNameCmp;
}

function glyphFilterFunc(item, searchItems) {
  if (!searchItems.length) {
    return true;
  }
  for (const searchString of searchItems) {
    if (item.glyphName.indexOf(searchString) >= 0) {
      return true;
    }
    if (item.unicodes[0] !== undefined) {
      const char = String.fromCodePoint(item.unicodes[0]);
      if (searchString === char) {
        return true;
      }
    }
  }
  return false;
}

function compare(a, b) {
  // sort undefined at the end
  if (a === b) {
    return 0;
  } else if (a === undefined) {
    return 1;
  } else if (b === undefined) {
    return -1;
  } else if (a < b) {
    return -1;
  } else {
    return 1;
  }
}
