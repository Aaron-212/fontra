import { chain } from "./utils.js";

export const controllerKey = Symbol("controller-key");

export class ObservableController {
  constructor(model) {
    if (!model) {
      model = {};
    }
    this.model = newModelProxy(this, model);
    this._rawModel = model;
    this._generalListeners = [];
    this._keyListeners = {};
  }

  addListener(listener) {
    this._generalListeners.push(listener);
  }

  removeListener(listener) {
    // Instead of using indexOf, we use filter, to ensure we also delete any duplicates
    this._generalListeners = this._generalListeners.filter((item) => item !== listener);
  }

  addKeyListener(key, listener) {
    if (!(key in this._keyListeners)) {
      this._keyListeners[key] = [];
    }
    this._keyListeners[key].push(listener);
  }

  removeKeyListener(key, listener) {
    if (!this._keyListeners[key]) {
      return;
    }
    // Instead of using indexOf, we use filter, to ensure we also delete any duplicates
    this._keyListeners[key] = this._keyListeners[key].filter(
      (item) => item !== listener
    );
  }

  setItem(key, newValue, senderInfo) {
    const oldValue = this._rawModel[key];
    if (newValue !== oldValue) {
      this._rawModel[key] = newValue;
      this._dispatchChange(key, newValue, oldValue, senderInfo);
    }
  }

  synchronizeWithLocalStorage(prefix = "") {
    synchronizeWithLocalStorage(this, prefix);
  }

  _dispatchChange(key, newValue, oldValue, senderInfo) {
    // Schedule the calls in the event loop rather than call immediately
    const event = { key, newValue, oldValue, senderInfo };
    for (const listener of chain(
      this._generalListeners,
      this._keyListeners[key] || []
    )) {
      setTimeout(() => listener(event), 0);
    }
  }
}

function newModelProxy(controller, model) {
  const handler = {
    set(model, key, newValue) {
      const oldValue = model[key];
      if (newValue !== oldValue) {
        model[key] = newValue;
        controller._dispatchChange(key, newValue, oldValue);
      }
      return true;
    },

    get(model, key, receiver) {
      if (key === controllerKey) {
        return controller;
      }
      return model[key];
    },

    deleteProperty(model, key) {
      const oldValue = model[key];
      if (oldValue !== undefined) {
        delete model[key];
        controller._dispatchChange(key, undefined, oldValue);
      }
      return true;
    },
  };

  return new Proxy(model, handler);
}

function synchronizeWithLocalStorage(controller, prefix = "") {
  const mapKeyToObject = {};
  const mapKeyToStorage = {};
  const stringKeys = {};
  for (const [key, value] of Object.entries(controller.model)) {
    const storageKey = prefix + key;
    mapKeyToObject[storageKey] = key;
    mapKeyToStorage[key] = storageKey;
    stringKeys[key] = typeof value === "string";
    const storedValue = localStorage.getItem(storageKey);
    if (storedValue !== null) {
      setItemOnObject(key, storedValue);
    }
  }

  function setItemOnObject(key, value) {
    if (!stringKeys[key]) {
      value = JSON.parse(value);
    }
    controller.model[key] = value;
  }

  function setItemOnStorage(key, value) {
    if (!stringKeys[key]) {
      value = JSON.stringify(value);
    }
    const storageKey = mapKeyToStorage[key];
    if (localStorage.getItem(storageKey) !== value) {
      localStorage.setItem(storageKey, value);
    }
  }

  controller.addListener((event) => {
    if (event.key in mapKeyToStorage) {
      setItemOnStorage(event.key, event.newValue);
    }
  });

  window.addEventListener("storage", (event) => {
    if (event.key in mapKeyToObject) {
      setItemOnObject(mapKeyToObject[event.key], event.newValue);
    }
  });
}
