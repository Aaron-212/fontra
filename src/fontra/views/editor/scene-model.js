import {
  centeredRect,
  insetRect,
  isEmptyRect,
  normalizeRect,
  offsetRect,
  pointInRect,
  sectRect,
  unionRect,
} from "../core/rectangle.js";
import { pointInConvexPolygon, rectIntersectsPolygon } from "../core/convex-hull.js";
import { enumerate, parseSelection } from "../core/utils.js";
import { difference, isEqualSet, updateSet } from "../core/set-ops.js";

export class SceneModel {
  constructor(fontController, isPointInPath) {
    this.fontController = fontController;
    this.isPointInPath = isPointInPath;
    this.glyphLines = [];
    this.positionedLines = [];
    this.selection = new Set();
    this.hoverSelection = new Set();
    this.selectedGlyph = undefined;
    this.selectedGlyphIsEditing = false;
    this.hoveredGlyph = undefined;
    this._globalLocation = undefined; // see getGlobalLocation()
    this._localLocations = {}; // glyph name -> local location
    this.textAlignment = "center";
    this.longestLineLength = 0;
    this.usedGlyphNames = new Set();
    this.cachedGlyphNames = new Set();
    this.backgroundLayers = {};
  }

  getSelectedPositionedGlyph() {
    return this.getPositionedGlyphFromSelection(this.selectedGlyph);
  }

  getHoveredPositionedGlyph() {
    return this.getPositionedGlyphFromSelection(this.hoveredGlyph);
  }

  getPositionedGlyphFromSelection(lineGlyphIndex) {
    if (!lineGlyphIndex) {
      return undefined;
    }
    const [lineIndex, glyphIndex] = lineGlyphIndex.split("/");
    return this.positionedLines[lineIndex]?.glyphs[glyphIndex];
  }

  getSelectedGlyphName() {
    return this.getSelectedPositionedGlyph()?.glyph.name;
  }

  async getSelectedVariableGlyphController() {
    if (!this.selectedGlyph) {
      return undefined;
    }
    return await this.fontController.getGlyph(this.getSelectedGlyphName());
  }

  getSelectedStaticGlyphController() {
    return this.getSelectedPositionedGlyph()?.glyph;
  }

  getSelectedGlyphState() {
    if (!this.selectedGlyph) {
      return undefined;
    }
    const [lineIndex, glyphIndex] = this.selectedGlyph.split("/");
    return {
      lineIndex: Number(lineIndex),
      glyphIndex: Number(glyphIndex),
      isEditing: this.selectedGlyphIsEditing,
    };
  }

  setSelectedGlyphState(state) {
    if (!state) {
      this.selectedGlyph = undefined;
      this.selectedGlyphIsEditing = false;
    } else {
      this.selectedGlyph = `${state.lineIndex}/${state.glyphIndex}`;
      this.selectedGlyphIsEditing = state.isEditing;
    }
  }

  getGlyphLines() {
    return this.glyphLines;
  }

  async setGlyphLines(glyphLines) {
    this.glyphLines = glyphLines;
    this.selection = new Set();
    this.hoverSelection = new Set();
    this.selectedGlyph = undefined;
    this.selectedGlyphIsEditing = false;
    this.hoveredGlyph = undefined;
    await this.updateScene();
  }

  async setTextAlignment(align) {
    this.textAlignment = align;
    if (this.glyphLines?.length) {
      await this.updateScene();
    }
  }

  getLocation() {
    const glyphName = this.getSelectedGlyphName();
    const location = {
      ...this.getGlobalLocation(),
      ...this._localLocations[glyphName],
    };
    return location;
  }

  getGlobalLocation() {
    if (this._globalLocation === undefined) {
      this._globalLocation = {};
      for (const axis of this.fontController.globalAxes) {
        this._globalLocation[axis.name] = axis.defaultValue;
      }
    }
    return this._globalLocation;
  }

  getLocalLocations(filterShownGlyphs = false) {
    let localLocations;
    if (filterShownGlyphs) {
      localLocations = {};
      for (const glyphLine of this.glyphLines) {
        for (const glyphInfo of glyphLine) {
          if (
            !localLocations[glyphInfo.glyphName] &&
            this._localLocations[glyphInfo.glyphName]
          ) {
            const localLocation = this._localLocations[glyphInfo.glyphName];
            if (Object.keys(localLocation).length) {
              localLocations[glyphInfo.glyphName] =
                this._localLocations[glyphInfo.glyphName];
            }
          }
        }
      }
    } else {
      localLocations = this._localLocations;
    }
    return localLocations;
  }

  async setLocation(location) {
    const glyphName = this.getSelectedGlyphName();
    const localLocation = { ...location };
    const globalLocation = {};
    for (const axis of this.fontController.globalAxes) {
      if (location[axis.name] !== undefined) {
        globalLocation[axis.name] = location[axis.name];
      }
      delete localLocation[axis.name];
    }
    this._globalLocation = globalLocation;
    if (glyphName !== undefined) {
      if (Object.keys(localLocation).length) {
        this._localLocations[glyphName] = localLocation;
      } else {
        delete this._localLocations[glyphName];
      }
    }
    await this.updateScene();
  }

  async setGlobalAndLocalLocations(globalLocation, localLocations) {
    this._globalLocation = globalLocation || {};
    this._localLocations = localLocations || {};
    await this.updateScene();
  }

  updateLocalLocations(localLocations) {
    this._localLocations = { ...this._localLocations, ...localLocations };
  }

  getTextHorizontalExtents() {
    switch (this.textAlignment) {
      case "left":
        return [0, this.longestLineLength];
      case "center":
        return [-this.longestLineLength / 2, this.longestLineLength / 2];
      case "right":
        return [-this.longestLineLength, 0];
    }
  }

  updateGlyphLinesCharacterMapping() {
    // Call this when the cmap changed: previously missing characters may now be
    // available, but may have a different glyph name, or a character may no longer
    // be available, in which case we set the isUndefined flag
    this.glyphLines = this.glyphLines.map((line) =>
      line.map((glyphInfo) => {
        const glyphName = glyphInfo.character
          ? this.fontController.characterMap[glyphInfo.character.codePointAt(0)]
          : undefined;
        if (glyphInfo.isUndefined && glyphName) {
          glyphInfo = {
            character: glyphInfo.character,
            glyphName: glyphName,
            isUndefined: false,
          };
        } else if (!glyphName) {
          glyphInfo = {
            character: glyphInfo.character,
            glyphName: glyphInfo.glyphName,
            isUndefined: true,
          };
        }
        return glyphInfo;
      })
    );
  }

  async updateBackgroundGlyphs() {
    this.backgroundLayerGlyphs = [];
    const glyphName = await this.getSelectedGlyphName();
    if (!glyphName) {
      return;
    }
    for (const [layerName, sourceName] of Object.entries(this.backgroundLayers)) {
      const varGlyph = await this.fontController.getGlyph(glyphName);
      let sourceIndex = varGlyph.getSourceIndexFromName(sourceName) || 0;
      const layerGlyph = await this.fontController.getLayerGlyphController(
        glyphName,
        layerName,
        sourceIndex
      );
      if (layerGlyph) {
        this.backgroundLayerGlyphs.push(layerGlyph);
      }
    }
  }

  async updateScene() {
    this.updateBackgroundGlyphs();
    [this.positionedLines, this.longestLineLength] = await buildScene(
      this.fontController,
      this.glyphLines,
      this.getGlobalLocation(),
      this._localLocations,
      this.textAlignment
    );

    const usedGlyphNames = getUsedGlyphNames(this.fontController, this.positionedLines);
    const cachedGlyphNames = difference(
      this.fontController.getCachedGlyphNames(),
      usedGlyphNames
    );

    this._adjustSubscriptions(usedGlyphNames, this.usedGlyphNames, true);
    this._adjustSubscriptions(cachedGlyphNames, this.cachedGlyphNames, false);

    this.usedGlyphNames = usedGlyphNames;
    this.cachedGlyphNames = cachedGlyphNames;
  }

  _adjustSubscriptions(currentGlyphNames, previousGlyphNames, wantLiveChanges) {
    if (isEqualSet(currentGlyphNames, previousGlyphNames)) {
      return;
    }
    const unsubscribeGlyphNames = difference(previousGlyphNames, currentGlyphNames);
    const subscribeGlyphNames = difference(currentGlyphNames, previousGlyphNames);
    if (unsubscribeGlyphNames.size) {
      this.fontController.unsubscribeChanges(
        makeGlyphNamesPattern(unsubscribeGlyphNames),
        wantLiveChanges
      );
    }
    if (subscribeGlyphNames.size) {
      this.fontController.subscribeChanges(
        makeGlyphNamesPattern(subscribeGlyphNames),
        wantLiveChanges
      );
    }
  }

  selectionAtPoint(point, size, currentSelection, preferTCenter) {
    if (!this.selectedGlyph || !this.selectedGlyphIsEditing) {
      return { selection: new Set() };
    }

    const pointSelection = this.pointSelectionAtPoint(point, size);
    if (pointSelection.size) {
      return { selection: pointSelection };
    }

    const { selection: segmentSelection, pathHit: pathHit } =
      this.segmentSelectionAtPoint(point, size);
    if (pathHit) {
      return { selection: segmentSelection, pathHit: pathHit };
    }

    const componentSelection = this.componentSelectionAtPoint(
      point,
      size,
      currentSelection,
      preferTCenter
    );
    return { selection: componentSelection };
  }

  pointSelectionAtPoint(point, size) {
    const positionedGlyph = this.getSelectedPositionedGlyph();

    const glyphPoint = {
      x: point.x - positionedGlyph.x,
      y: point.y - positionedGlyph.y,
    };
    const pointIndex = positionedGlyph.glyph.path.pointIndexNearPoint(glyphPoint, size);
    if (pointIndex !== undefined) {
      return new Set([`point/${pointIndex}`]);
    }
    return new Set();
  }

  segmentSelectionAtPoint(point, size) {
    const pathHit = this.pathHitAtPoint(point, size);
    if (pathHit.contourIndex !== undefined) {
      const selection = new Set(
        pathHit.segment.parentPointIndices.map((i) => `point/${i}`)
      );
      return { selection, pathHit };
    }
    return { selection: new Set() };
  }

  componentSelectionAtPoint(point, size, currentSelection, preferTCenter) {
    const positionedGlyph = this.getSelectedPositionedGlyph();

    let currentSelectedComponentIndices;
    if (currentSelection) {
      const { component, componentOrigin, componentTCenter } =
        parseSelection(currentSelection);
      currentSelectedComponentIndices = new Set([
        ...(component || []),
        ...(componentOrigin || []),
        ...(componentTCenter || []),
      ]);
    }
    const components = positionedGlyph.glyph.components;
    const x = point.x - positionedGlyph.x;
    const y = point.y - positionedGlyph.y;
    const selRect = centeredRect(x, y, size);
    const componentHullMatches = [];
    for (let i = components.length - 1; i >= 0; i--) {
      const component = components[i];
      if (currentSelectedComponentIndices?.has(i)) {
        const compo = component.compo;
        const originMatch = pointInRect(
          compo.transformation.translateX,
          compo.transformation.translateY,
          selRect
        );
        const tCenterMatch = pointInRect(
          compo.transformation.translateX + compo.transformation.tCenterX,
          compo.transformation.translateY + compo.transformation.tCenterY,
          selRect
        );
        if (originMatch || tCenterMatch) {
          const selection = new Set([]);
          if (originMatch && (!tCenterMatch || !preferTCenter)) {
            selection.add(`componentOrigin/${i}`);
          }
          if (tCenterMatch && (!originMatch || preferTCenter)) {
            selection.add(`componentTCenter/${i}`);
          }
          return selection;
        }
      }
      if (
        pointInRect(x, y, component.controlBounds) &&
        this.isPointInPath(component.path2d, x, y)
      ) {
        componentHullMatches.push({ index: i, component: component });
      }
    }
    switch (componentHullMatches.length) {
      case 0:
        return new Set();
      case 1:
        return new Set([`component/${componentHullMatches[0].index}`]);
    }
    // If we have multiple matches, take the first that has an actual
    // point inside the path, and not just inside the hull
    for (const match of componentHullMatches) {
      if (this.isPointInPath(match.component.path2d, x, y)) {
        return new Set([`component/${match.index}`]);
      }
    }
    // Else, fall back to the first match
    return new Set([`component/${componentHullMatches[0].index}`]);
  }

  selectionAtRect(selRect, pointFilterFunc) {
    const selection = new Set();
    if (!this.selectedGlyph || !this.selectedGlyphIsEditing) {
      return selection;
    }
    const positionedGlyph = this.getSelectedPositionedGlyph();
    selRect = offsetRect(selRect, -positionedGlyph.x, -positionedGlyph.y);
    for (const hit of positionedGlyph.glyph.path.iterPointsInRect(selRect)) {
      if (!pointFilterFunc || pointFilterFunc(hit)) {
        selection.add(`point/${hit.pointIndex}`);
      }
    }
    const components = positionedGlyph.glyph.components;
    for (let i = 0; i < components.length; i++) {
      if (components[i].intersectsRect(selRect)) {
        selection.add(`component/${i}`);
      }
    }
    return selection;
  }

  pathHitAtPoint(point, size) {
    if (!this.selectedGlyph || !this.selectedGlyphIsEditing) {
      return {};
    }
    const positionedGlyph = this.getSelectedPositionedGlyph();
    const glyphPoint = {
      x: point.x - positionedGlyph.x,
      y: point.y - positionedGlyph.y,
    };
    return positionedGlyph.glyph.pathHitTester.hitTest(glyphPoint, size / 2);
  }

  glyphAtPoint(point, skipEditingGlyph = true) {
    const matches = [];
    for (let i = this.positionedLines.length - 1; i >= 0; i--) {
      const positionedLine = this.positionedLines[i];
      if (
        !positionedLine.bounds ||
        !pointInRect(point.x, point.y, positionedLine.bounds)
      ) {
        continue;
      }
      for (let j = positionedLine.glyphs.length - 1; j >= 0; j--) {
        const positionedGlyph = positionedLine.glyphs[j];
        if (
          !positionedGlyph.bounds ||
          !pointInRect(point.x, point.y, positionedGlyph.bounds)
        ) {
          continue;
        }
        if (
          positionedGlyph.isEmpty ||
          pointInConvexPolygon(
            point.x - positionedGlyph.x,
            point.y - positionedGlyph.y,
            positionedGlyph.glyph.convexHull
          )
        ) {
          if (
            !skipEditingGlyph ||
            !this.selectedGlyphIsEditing ||
            `${i}/${j}` != this.selectedGlyph
          ) {
            matches.push([i, j]);
          }
        }
      }
    }
    let foundGlyph = undefined;
    if (matches.length == 1) {
      const [i, j] = matches[0];
      foundGlyph = `${i}/${j}`;
    } else if (matches.length > 1) {
      // The target point is inside the convex hull of multiple glyphs.
      // We prefer the glyph that has the point properly inside, and if
      // that doesn't resolve it we take the glyph with the smallest
      // convex hull area, as that's the one most likely to be hard to
      // hit otherwise.
      // These heuristics should help selecting the glyph intended by the
      // user, regardless of its order in the string.
      const decoratedMatches = matches.map(([i, j]) => {
        const positionedGlyph = this.positionedLines[i].glyphs[j];
        return {
          i: i,
          j: j,
          inside: this.isPointInPath(
            positionedGlyph.glyph.flattenedPath2d,
            point.x - positionedGlyph.x,
            point.y - positionedGlyph.y
          ),
          area: positionedGlyph.glyph.convexHullArea,
        };
      });
      decoratedMatches.sort((a, b) => b.inside - a.inside || a.area - b.area);
      const { i, j } = decoratedMatches[0];
      foundGlyph = `${i}/${j}`;
    }
    return foundGlyph;
  }

  getSceneBounds() {
    let bounds = undefined;
    for (const line of this.positionedLines) {
      for (const glyph of line.glyphs) {
        if (!bounds) {
          bounds = glyph.bounds;
        } else if (glyph.bounds) {
          bounds = unionRect(bounds, glyph.bounds);
        }
      }
    }
    return bounds;
  }

  getSelectionBox() {
    if (!this.selectedGlyph) {
      return this.getSceneBounds();
    }
    let bounds;
    if (this.selectedGlyphIsEditing && this.selection.size) {
      const positionedGlyph = this.getSelectedPositionedGlyph();
      const [x, y] = [positionedGlyph.x, positionedGlyph.y];
      const instance = this.getSelectedStaticGlyphController();
      const boundses = [];

      const { point: selectedPointIndices, component: selectedComponentIndices } =
        parseSelection(this.selection);

      selectedPointIndices?.forEach((pointIndex) => {
        const pt = instance.path.getPoint(pointIndex);
        boundses.push(offsetRect(centeredRect(pt.x, pt.y, 0, 0), x, y));
      });

      selectedComponentIndices?.forEach((componentIndex) => {
        if (!instance.components[componentIndex]) {
          // Invalid selection
          return;
        }
        boundses.push(
          offsetRect(instance.components[componentIndex].controlBounds, x, y)
        );
      });

      if (boundses.length) {
        bounds = unionRect(...boundses);
      }
    }
    if (!bounds) {
      const positionedGlyph = this.getSelectedPositionedGlyph();
      bounds = positionedGlyph.bounds;
    }
    if (!bounds) {
      bounds = this.getSceneBounds();
    }
    return bounds;
  }
}

function mergeAxisInfo(axisInfos) {
  // This returns a list of axes that is a superset of all the axis
  // sets of the input.
  if (!axisInfos.length) {
    return [];
  }
  const mergedAxisInfo = { ...axisInfos[0] };
  for (let i = 1; i < axisInfos.length; i++) {
    for (const axisInfo of Object.values(axisInfos[i])) {
      if (mergedAxisInfo[axisInfo.name] !== undefined) {
        mergedAxisInfo[axisInfo.name].minValue = Math.min(
          mergedAxisInfo[axisInfo.name].minValue,
          axisInfo.minValue
        );
        mergedAxisInfo[axisInfo.name].maxValue = Math.max(
          mergedAxisInfo[axisInfo.name].maxValue,
          axisInfo.maxValue
        );
      } else {
        mergedAxisInfo[axisInfo.name] = { ...axisInfo };
      }
    }
  }
  return Object.values(mergedAxisInfo);
}

async function buildScene(
  fontController,
  glyphLines,
  globalLocation,
  localLocations,
  align = "center"
) {
  let y = 0;
  const lineDistance = 1.1 * fontController.unitsPerEm; // TODO make factor user-configurable
  const positionedLines = [];
  let longestLineLength = 0;
  for (const glyphLine of glyphLines) {
    const positionedLine = { glyphs: [] };
    let x = 0;
    for (const glyphInfo of glyphLine) {
      const location = { ...localLocations[glyphInfo.glyphName], ...globalLocation };
      let glyphInstance = await fontController.getGlyphInstance(
        glyphInfo.glyphName,
        location
      );
      const isUndefined = !glyphInstance;
      if (isUndefined) {
        glyphInstance = fontController.getDummyGlyphInstanceController(
          glyphInfo.glyphName
        );
      }
      positionedLine.glyphs.push({
        x: x,
        y: y,
        glyph: glyphInstance,
        glyphName: glyphInfo.glyphName,
        character: glyphInfo.character,
        isUndefined: isUndefined,
      });
      x += glyphInstance.xAdvance;
    }

    longestLineLength = Math.max(longestLineLength, x);

    let offset = 0;
    if (align === "center") {
      offset = -x / 2;
    } else if (align === "right") {
      offset = -x;
    }
    if (offset) {
      positionedLine.glyphs.forEach((item) => {
        item.x += offset;
      });
    }

    // Add bounding boxes
    positionedLine.glyphs.forEach((item) => {
      let bounds = item.glyph.controlBounds;
      if (!bounds || isEmptyRect(bounds) || item.glyph.isEmptyIsh) {
        // Empty glyph, make up box based on advance so it can still be clickable/hoverable
        // TODO: use font's ascender/descender values
        // If the advance is very small, add a bit of extra space on both sides so it'll be
        // clickable even with a zero advance width
        const extraSpace = item.glyph.xAdvance < 30 ? 20 : 0;
        bounds = insetRect(
          normalizeRect({
            xMin: 0,
            yMin: -0.2 * fontController.unitsPerEm,
            xMax: item.glyph.xAdvance,
            yMax: 0.8 * fontController.unitsPerEm,
          }),
          -extraSpace,
          0
        );
        item.isEmpty = true;
      }
      item.bounds = offsetRect(bounds, item.x, item.y);
      item.unpositionedBounds = bounds;
    });

    y -= lineDistance;
    if (positionedLine.glyphs.length) {
      positionedLine.bounds = unionRect(
        ...positionedLine.glyphs.map((glyph) => glyph.bounds)
      );
      positionedLines.push(positionedLine);
    }
  }
  return [positionedLines, longestLineLength];
}

function getUsedGlyphNames(fontController, positionedLines) {
  const usedGlyphNames = new Set();
  for (const line of positionedLines) {
    for (const glyph of line.glyphs) {
      usedGlyphNames.add(glyph.glyph.name);
      updateSet(usedGlyphNames, fontController.iterGlyphMadeOf(glyph.glyph.name));
    }
  }
  return usedGlyphNames;
}

function makeGlyphNamesPattern(glyphNames) {
  const glyphsObj = {};
  for (const glyphName of glyphNames) {
    glyphsObj[glyphName] = null;
  }
  return { glyphs: glyphsObj };
}
