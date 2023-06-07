import * as html from "/core/unlit.js";
import { reversed, capitalizeFirstLetter } from "/core/utils.js";
import { SimpleElement } from "/core/unlit.js";
import { themeColorCSS } from "./theme-support.js";

export const MenuItemDivider = { title: "-" };

export function showMenu(menuItems, position, positionContainer, container) {
  if (!position) {
    const { x, y } = window.event;
    position = { x: x + 2, y: y - 2 };
  }
  if (!container) {
    container = document.querySelector("#menu-panel-container");
  }
  const menu = new MenuPanel(menuItems, position, positionContainer);
  container.appendChild(menu);
}

class MenuPanel extends SimpleElement {
  static openMenuPanels = [];

  static closeAllMenus(event) {
    if (event) {
      if (event.target instanceof MenuPanel) {
        return;
      }
    }
    for (const element of MenuPanel.openMenuPanels) {
      element.parentElement?.removeChild(element);
    }
    MenuPanel.openMenuPanels.splice(0, MenuPanel.openMenuPanels.length);
  }

  static colors = {
    "background-color": ["#f0f0f0", "#333"],
    "foreground-color": ["black", "white"],
    "background-active-color": ["var(--fontra-red-color)", "var(--fontra-red-color)"],
    "foreground-active-color": ["white", "white"],
  };

  static styles = `
    ${themeColorCSS(MenuPanel.colors)}

    :host {
      position: absolute;
      z-index: 10000;
      color: var(--foreground-color);
      background-color: var(--background-color);
      border-radius: 6px;
      border: solid gray 0.5px;
      outline: none;
      box-shadow: 2px 3px 10px #00000020;
      font-size: 1rem;
      user-select: none;
      cursor: default;
    }

    .menu-item-divider {
      border: none;
      border-top: 1px solid #80808080;
      height: 1px;
    }

    .context-menu-item {
      padding: 0.1em 0.8em 0.1em 1em; /* top, right, bottom, left */
      color: #8080a0;
    }

    .context-menu-item.enabled {
      color: inherit;
    }

    .context-menu-item.enabled.selected {
      color: var(--foreground-active-color);
      background-color: var(--background-active-color);
      cursor: pointer;
    }

    .context-menu-item > div {
      display: flex;
      gap: 0.5em;
      justify-content: space-between;
    }
  `;

  constructor(menuItems, position, positionContainer) {
    super();
    this.menuElement = html.div({ tabindex: 0 });

    for (const item of menuItems) {
      let itemElement;
      if (item === MenuItemDivider || item.title === "-") {
        itemElement = html.hr({ class: "menu-item-divider" });
      } else {
        itemElement = html.div(
          {
            class: `context-menu-item ${item.enabled() ? "enabled" : ""}`,
            onmouseenter: (event) => this.selectItem(itemElement),
            onmousemove: (event) => {
              if (!itemElement.classList.contains("selected")) {
                this.selectItem(itemElement);
              }
            },
            onmouseleave: (event) => itemElement.classList.remove("selected"),
            onclick: (event) => {
              event.preventDefault();
              event.stopImmediatePropagation();
              if (item.enabled()) {
                item.callback?.(event);
                this.dismiss();
              }
            },
          },
          [
            html.div({}, [
              typeof item.title === "function" ? item.title() : item.title,
              html.span({}, [buildShortCutString(item.shortCut)]),
            ]),
          ]
        );
      }
      this.menuElement.appendChild(itemElement);
    }

    this.style = `left: ${position.x}px; top: ${position.y}px;`;
    this._attachStyles();
    this.shadowRoot.appendChild(this.menuElement);
    this.tabIndex = 0;
    this.addEventListener("keydown", (event) => this.handleKeyDown(event));
    // this.addEventListener("click", (event) => console.log("clikkk", event));
    MenuPanel.openMenuPanels.push(this);
  }

  connectedCallback() {
    this._savedActiveElement = document.activeElement;
    this.focus();
  }

  dismiss() {
    const index = MenuPanel.openMenuPanels.indexOf(this);
    if (index >= 0) {
      MenuPanel.openMenuPanels.splice(index, 1);
    }
    this.parentElement?.removeChild(this);
    this._savedActiveElement?.focus();
  }

  selectItem(itemElement) {
    const selectedItem = this.findSelectedItem();
    if (selectedItem && selectedItem !== itemElement) {
      selectedItem.classList.remove("selected");
    }
    itemElement.classList.add("selected");
  }

  handleKeyDown(event) {
    event.stopImmediatePropagation();
    switch (event.key) {
      case "Escape":
        this.dismiss();
        break;
      case "ArrowDown":
        this.selectPrevNext(true);
        break;
      case "ArrowUp":
        this.selectPrevNext(false);
        break;
      case "Enter":
        const selectedItem = this.findSelectedItem();
        if (selectedItem) {
          selectedItem.onclick(event);
        }
        break;
    }
  }

  findSelectedItem() {
    let selectedItem;
    for (const item of this.menuElement.children) {
      if (item.classList.contains("selected")) {
        return item;
      }
    }
  }

  selectPrevNext(isNext) {
    const selectedChild = this.findSelectedItem();

    if (selectedChild) {
      let sibling;
      if (isNext) {
        sibling = selectedChild.nextElementSibling;
      } else {
        sibling = selectedChild.previousElementSibling;
      }
      while (sibling) {
        if (sibling.classList.contains("enabled")) {
          sibling.classList.add("selected");
          selectedChild.classList.remove("selected");
          break;
        }
        if (isNext) {
          sibling = sibling.nextElementSibling;
        } else {
          sibling = sibling.previousElementSibling;
        }
      }
    } else {
      const f = isNext ? (a) => a : reversed;
      for (const item of f(this.menuElement.children)) {
        if (item.classList.contains("enabled")) {
          this.selectItem(item);
          break;
        }
      }
    }
  }
}

customElements.define("menu-panel", MenuPanel);

export const shortCutKeyMap = {
  ArrowUp: "↑",
  ArrowDown: "↓",
  Delete: "⌫",
};

function buildShortCutString(shortCutDefinition) {
  let shorcutCommand = "";

  if (shortCutDefinition) {
    const isMac = navigator.platform.toLowerCase().indexOf("mac") >= 0;

    if (shortCutDefinition.shiftKey) {
      shorcutCommand += isMac ? "\u21e7" : "Shift+"; // ⇧ or Shift
    }
    if (shortCutDefinition.metaKey) {
      shorcutCommand += isMac ? "\u2318" : "Ctrl+"; // ⌘ or Ctrl
    }
    if (shortCutDefinition.keysOrCodes) {
      // If the definition specifies multiple keys, e.g ["Delete", "Backspace"],
      // we are taking the first key for comparison with the map
      const key = shortCutDefinition.keysOrCodes[0];
      shorcutCommand += shortCutKeyMap[key] || capitalizeFirstLetter(key);
    }
  }

  return shorcutCommand;
}

window.addEventListener("mousedown", (event) => MenuPanel.closeAllMenus(event));
window.addEventListener("blur", (event) => MenuPanel.closeAllMenus(event));
