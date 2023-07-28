import { difference, isSuperset, union } from "../core/set-ops.js";
import {
  enumerate,
  makeAffineTransform,
  makeUPlusStringFromCodePoint,
  parseSelection,
  withSavedState,
} from "/core/utils.js";
import { subVectors } from "../core/vector.js";

export const visualizationLayerDefinitions = [];

export function registerVisualizationLayerDefinition(newLayerDef) {
  let index = 0;
  let layerDef;
  for (index = 0; index < visualizationLayerDefinitions.length; index++) {
    layerDef = visualizationLayerDefinitions[index];
    if (newLayerDef.zIndex < layerDef.zIndex) {
      break;
    }
  }
  visualizationLayerDefinitions.splice(index, 0, newLayerDef);
}

registerVisualizationLayerDefinition({
  identifier: "fontra.upm.grid",
  name: "Units-per-em grid",
  selectionMode: "editing",
  userSwitchable: true,
  defaultOn: true,
  zIndex: 0,
  dontTranslate: true,
  screenParameters: { strokeWidth: 2 },
  colors: { strokeColor: "#FFF" },
  colorsDarkMode: { strokeColor: "#3C3C3C" },
  draw: (context, positionedGlyph, parameters, model, controller) => {
    if (controller.magnification < 4) {
      return;
    }
    context.strokeStyle = parameters.strokeColor;
    context.lineWidth = parameters.strokeWidth;
    let { xMin, yMin, xMax, yMax } = controller.getViewBox();
    xMin -= positionedGlyph.x;
    xMax -= positionedGlyph.x;
    yMin -= positionedGlyph.y;
    yMax -= positionedGlyph.y;
    for (let x = Math.floor(xMin); x < Math.ceil(xMax); x++) {
      strokeLine(context, x, yMin, x, yMax);
    }
    for (let y = Math.floor(yMin); y < Math.ceil(yMax); y++) {
      strokeLine(context, xMin, y, xMax, y);
    }
  },
});

registerVisualizationLayerDefinition({
  identifier: "fontra.empty.selected.glyph",
  name: "Empty selected glyph",
  selectionMode: "selected",
  selectionFilter: (positionedGlyph) => positionedGlyph.isEmpty,
  zIndex: 200,
  colors: { fillColor: "#D8D8D8" /* Must be six hex digits */ },
  colorsDarkMode: { fillColor: "#585858" /* Must be six hex digits */ },
  draw: (context, positionedGlyph, parameters, model, controller) => {
    _drawEmptyGlyphLayer(context, positionedGlyph, parameters, model, controller);
  },
});

registerVisualizationLayerDefinition({
  identifier: "fontra.empty.hovered.glyph",
  name: "Empty hovered glyph",
  selectionMode: "hovered",
  selectionFilter: (positionedGlyph) => positionedGlyph.isEmpty,
  zIndex: 200,
  colors: { fillColor: "#E8E8E8" /* Must be six hex digits */ },
  colorsDarkMode: { fillColor: "#484848" /* Must be six hex digits */ },
  draw: (context, positionedGlyph, parameters, model, controller) => {
    _drawEmptyGlyphLayer(context, positionedGlyph, parameters, model, controller);
  },
});

function _drawEmptyGlyphLayer(context, positionedGlyph, parameters, model, controller) {
  const box = positionedGlyph.unpositionedBounds;
  const fillColor = parameters.fillColor;
  if (fillColor[0] === "#" && fillColor.length === 7) {
    const gradient = context.createLinearGradient(0, box.yMin, 0, box.yMax);
    gradient.addColorStop(0.0, fillColor + "00");
    gradient.addColorStop(0.2, fillColor + "DD");
    gradient.addColorStop(0.5, fillColor + "FF");
    gradient.addColorStop(0.8, fillColor + "DD");
    gradient.addColorStop(1.0, fillColor + "00");
    context.fillStyle = gradient;
  } else {
    context.fillStyle = fillColor;
  }
  context.fillRect(box.xMin, box.yMin, box.xMax - box.xMin, box.yMax - box.yMin);
}

registerVisualizationLayerDefinition({
  identifier: "fontra.context.glyphs",
  name: "Context glyphs",
  selectionMode: "unselected",
  zIndex: 200,
  colors: { fillColor: "#000" },
  colorsDarkMode: { fillColor: "#FFF" },
  draw: (context, positionedGlyph, parameters, model, controller) => {
    context.fillStyle = parameters.fillColor;
    context.fill(positionedGlyph.glyph.flattenedPath2d);
  },
});

registerVisualizationLayerDefinition({
  identifier: "fontra.undefined.glyph",
  name: "Undefined glyph",
  selectionMode: "all",
  selectionFilter: (positionedGlyph) => positionedGlyph.isUndefined,
  zIndex: 500,
  colors: {
    fillColor: "#0006",
  },
  colorsDarkMode: {
    fillColor: "#FFF6",
  },
  draw: (context, positionedGlyph, parameters, model, controller) => {
    context.fillStyle = parameters.fillColor;
    context.textAlign = "center";
    const lineDistance = 1.2;

    const glyphNameFontSize = 0.1 * positionedGlyph.glyph.xAdvance;
    const placeholderFontSize = 0.75 * positionedGlyph.glyph.xAdvance;
    context.font = `${glyphNameFontSize}px fontra-ui-regular, sans-serif`;
    context.scale(1, -1);
    context.fillText(positionedGlyph.glyphName, positionedGlyph.glyph.xAdvance / 2, 0);
    if (positionedGlyph.character) {
      const uniStr = makeUPlusStringFromCodePoint(
        positionedGlyph.character.codePointAt(0)
      );
      context.fillText(
        uniStr,
        positionedGlyph.glyph.xAdvance / 2,
        -lineDistance * glyphNameFontSize
      );
      context.font = `${placeholderFontSize}px fontra-ui-regular, sans-serif`;
      context.fillText(
        positionedGlyph.character,
        positionedGlyph.glyph.xAdvance / 2,
        -lineDistance * glyphNameFontSize - 0.4 * placeholderFontSize
      );
    }
  },
});

registerVisualizationLayerDefinition({
  identifier: "fontra.baseline",
  name: "Baseline",
  selectionMode: "editing",
  userSwitchable: true,
  defaultOn: false,
  zIndex: 500,
  screenParameters: { strokeWidth: 1 },
  colors: { strokeColor: "#0004" },
  colorsDarkMode: { strokeColor: "#FFF6" },
  draw: (context, positionedGlyph, parameters, model, controller) => {
    context.strokeStyle = parameters.strokeColor;
    context.lineWidth = parameters.strokeWidth;
    strokeLine(context, 0, 0, positionedGlyph.glyph.xAdvance, 0);
  },
});

registerVisualizationLayerDefinition({
  identifier: "fontra.sidebearings",
  name: "Sidebearings",
  selectionMode: "editing",
  zIndex: 500,
  screenParameters: { strokeWidth: 1, extent: 16 },
  colors: { strokeColor: "#0004" },
  colorsDarkMode: { strokeColor: "#FFF6" },
  draw: _drawMiniSideBearings,
});

registerVisualizationLayerDefinition({
  identifier: "fontra.sidebearings.unselected",
  name: "Sidebearings for non-editing glyphs",
  selectionMode: "notediting",
  userSwitchable: true,
  defaultOn: false,
  zIndex: 190,
  screenParameters: { strokeWidth: 1, extent: 16 },
  colors: { strokeColor: "#0004" },
  colorsDarkMode: { strokeColor: "#FFF6" },
  draw: _drawMiniSideBearings,
});

function _drawMiniSideBearings(
  context,
  positionedGlyph,
  parameters,
  model,
  controller
) {
  const glyph = positionedGlyph.glyph;
  context.strokeStyle = parameters.strokeColor;
  context.lineWidth = parameters.strokeWidth;
  const extent = parameters.extent;
  strokeLine(context, 0, -extent, 0, extent);
  strokeLine(context, glyph.xAdvance, -extent, glyph.xAdvance, extent);
  if (extent < glyph.xAdvance / 2) {
    strokeLine(context, 0, 0, extent, 0);
    strokeLine(context, glyph.xAdvance, 0, glyph.xAdvance - extent, 0);
  } else {
    strokeLine(context, 0, 0, glyph.xAdvance, 0);
  }
}

registerVisualizationLayerDefinition({
  identifier: "fontra.crosshair",
  name: "Drag crosshair",
  selectionMode: "editing",
  userSwitchable: true,
  defaultOn: false,
  zIndex: 500,
  screenParameters: { strokeWidth: 1, lineDash: [4, 4] },
  colors: { strokeColor: "#8888" },
  colorsDarkMode: { strokeColor: "#AAA8" },
  draw: (context, positionedGlyph, parameters, model, controller) => {
    const pointIndex = model.initialClickedPointIndex;
    if (pointIndex === undefined) {
      return;
    }
    const { x, y } = positionedGlyph.glyph.path.getPoint(pointIndex);
    context.strokeStyle = parameters.strokeColor;
    context.lineWidth = parameters.strokeWidth;
    context.setLineDash(parameters.lineDash);
    const { xMin, yMin, xMax, yMax } = controller.getViewBox();
    const dx = -positionedGlyph.x;
    const dy = -positionedGlyph.y;
    strokeLine(context, x, yMin + dy, x, yMax + dy);
    strokeLine(context, xMin + dx, y, xMax + dx, y);
  },
});

registerVisualizationLayerDefinition({
  identifier: "fontra.ghostpath",
  name: "Drag “ghost” path",
  selectionMode: "editing",
  userSwitchable: true,
  defaultOn: true,
  zIndex: 500,
  screenParameters: { strokeWidth: 1 },
  colors: { strokeColor: "#AAA6" },
  colorsDarkMode: { strokeColor: "#8886" },
  draw: (context, positionedGlyph, parameters, model, controller) => {
    if (!model.ghostPath) {
      return;
    }
    context.lineJoin = "round";
    context.strokeStyle = parameters.strokeColor;
    context.lineWidth = parameters.strokeWidth;
    context.stroke(model.ghostPath);
  },
});

registerVisualizationLayerDefinition({
  identifier: "fontra.edit.path.fill",
  name: "Edit path fill",
  selectionMode: "editing",
  zIndex: 500,
  screenParameters: { strokeWidth: 1 },
  colors: { fillColor: "#0001" },
  colorsDarkMode: { fillColor: "#FFF3" },
  draw: (context, positionedGlyph, parameters, model, controller) => {
    context.fillStyle = parameters.fillColor;
    context.fill(positionedGlyph.glyph.closedContoursPath2d);
  },
});

registerVisualizationLayerDefinition({
  identifier: "fontra.selected.glyph",
  name: "Selected glyph",
  selectionMode: "selected",
  selectionFilter: (positionedGlyph) => !positionedGlyph.isEmpty,
  zIndex: 200,
  screenParameters: { outerStrokeWidth: 10, innerStrokeWidth: 3 },
  colors: { fillColor: "#000", strokeColor: "#7778" },
  colorsDarkMode: { fillColor: "#FFF", strokeColor: "#FFF8" },
  draw: (context, positionedGlyph, parameters, model, controller) => {
    _drawSelectedGlyphLayer(context, positionedGlyph, parameters);
  },
});

registerVisualizationLayerDefinition({
  identifier: "fontra.hovered.glyph",
  name: "Hovered glyph",
  selectionMode: "hovered",
  selectionFilter: (positionedGlyph) => !positionedGlyph.isEmpty,
  zIndex: 200,
  screenParameters: { outerStrokeWidth: 10, innerStrokeWidth: 3 },
  colors: { fillColor: "#000", strokeColor: "#BBB8" },
  colorsDarkMode: { fillColor: "#FFF", strokeColor: "#CCC8" },
  draw: (context, positionedGlyph, parameters, model, controller) => {
    _drawSelectedGlyphLayer(context, positionedGlyph, parameters);
  },
});

function _drawSelectedGlyphLayer(context, positionedGlyph, parameters) {
  drawWithDoubleStroke(
    context,
    positionedGlyph.glyph.flattenedPath2d,
    parameters.outerStrokeWidth,
    parameters.innerStrokeWidth,
    parameters.strokeColor,
    parameters.fillColor
  );
}

registerVisualizationLayerDefinition({
  identifier: "fontra.component.selection",
  name: "Component selection",
  selectionMode: "editing",
  zIndex: 500,
  screenParameters: {
    hoveredStrokeWidth: 3,
    selectedStrokeWidth: 3,
    originMarkerStrokeWidth: 1,
    selectedOriginMarkerStrokeWidth: 2,
    originMarkerSize: 10,
    originMarkerRadius: 4,
  },
  colors: {
    hoveredStrokeColor: "#CCC",
    selectedStrokeColor: "#888",
    originMarkerColor: "#BBB",
    tCenterMarkerColor: "#777",
  },
  colorsDarkMode: {
    hoveredStrokeColor: "#666",
    selectedStrokeColor: "#AAA",
    originMarkerColor: "#BBB",
    tCenterMarkerColor: "#DDD",
  },
  draw: (context, positionedGlyph, parameters, model, controller) => {
    const glyph = positionedGlyph.glyph;

    const selectedItems = parseComponentSelection(
      model.selection || new Set(),
      glyph.components.length
    );
    const hoveredItems = parseComponentSelection(
      model.hoverSelection || new Set(),
      glyph.components.length
    );

    selectedItems.component = union(
      union(selectedItems.component, selectedItems.componentOrigin),
      selectedItems.componentTCenter
    );

    hoveredItems.component = union(
      union(hoveredItems.component, hoveredItems.componentOrigin),
      hoveredItems.componentTCenter
    );

    hoveredItems.component = difference(
      hoveredItems.component,
      selectedItems.component
    );
    hoveredItems.componentOrigin = difference(
      hoveredItems.componentOrigin,
      selectedItems.componentOrigin
    );
    hoveredItems.componentTCenter = difference(
      hoveredItems.componentTCenter,
      selectedItems.componentTCenter
    );

    const relevantComponents = union(selectedItems.component, hoveredItems.component);

    const visibleMarkers = {
      componentOrigin: difference(
        difference(relevantComponents, selectedItems.componentOrigin),
        hoveredItems.componentOrigin
      ),
      componentTCenter: difference(
        difference(relevantComponents, selectedItems.componentTCenter),
        hoveredItems.componentTCenter
      ),
    };

    const hoveredParms = {
      color: parameters.hoveredStrokeColor,
      width: parameters.hoveredStrokeWidth,
    };
    const selectedParms = {
      color: parameters.selectedStrokeColor,
      width: parameters.selectedStrokeWidth,
    };

    context.lineJoin = "round";
    context.lineCap = "round";

    for (const [componentIndices, parms] of [
      [hoveredItems.component, hoveredParms],
      [selectedItems.component, selectedParms],
    ]) {
      for (const componentIndex of componentIndices) {
        const componentController = glyph.components[componentIndex];

        context.lineWidth = parms.width;
        context.strokeStyle = parms.color;
        context.stroke(componentController.path2d);
      }
    }

    const markerVisibleParms = {
      color: parameters.hoveredStrokeColor,
      width: parameters.originMarkerStrokeWidth,
    };
    const markerHoveredParms = {
      color: parameters.hoveredStrokeColor,
      width: parameters.selectedOriginMarkerStrokeWidth,
    };
    const markerSelectedParms = {
      color: parameters.selectedStrokeColor,
      width: parameters.selectedOriginMarkerStrokeWidth,
    };

    for (const [markers, parms] of [
      [visibleMarkers, markerVisibleParms],
      [hoveredItems, markerHoveredParms],
      [selectedItems, markerSelectedParms],
    ]) {
      // Component origin
      context.lineWidth = parms.width;
      context.strokeStyle = parameters.originMarkerColor;
      for (const componentIndex of markers.componentOrigin) {
        const componentController = glyph.components[componentIndex];
        const component = componentController.compo;

        const transformation = component.transformation;
        const [x, y] = [transformation.translateX, transformation.translateY];
        strokeLine(
          context,
          x - parameters.originMarkerSize,
          y,
          x + parameters.originMarkerSize,
          y
        );
        strokeLine(
          context,
          x,
          y - parameters.originMarkerSize,
          x,
          y + parameters.originMarkerSize
        );
      }

      // Component transformation center
      context.lineWidth = parms.width;
      context.strokeStyle = parameters.tCenterMarkerColor;
      for (const componentIndex of markers.componentTCenter) {
        const componentController = glyph.components[componentIndex];
        const component = componentController.compo;
        const transformation = component.transformation;

        const affine = makeAffineTransform(transformation);
        const [cx, cy] = affine.transformPoint(
          transformation.tCenterX,
          transformation.tCenterY
        );
        const pt1 = affine.transformPoint(
          transformation.tCenterX - parameters.originMarkerSize,
          transformation.tCenterY
        );
        const pt2 = affine.transformPoint(
          transformation.tCenterX + parameters.originMarkerSize,
          transformation.tCenterY
        );
        const pt3 = affine.transformPoint(
          transformation.tCenterX,
          transformation.tCenterY - parameters.originMarkerSize
        );
        const pt4 = affine.transformPoint(
          transformation.tCenterX,
          transformation.tCenterY + parameters.originMarkerSize
        );
        strokeLine(context, ...pt1, ...pt2);
        strokeLine(context, ...pt3, ...pt4);
        strokeCircle(context, cx, cy, parameters.originMarkerRadius);
      }
    }
  },
});

function parseComponentSelection(selection, numComponents) {
  const parsed = parseSelection(selection);
  const result = {};
  for (const prop of ["component", "componentOrigin", "componentTCenter"]) {
    result[prop] = new Set((parsed[prop] || []).filter((i) => i < numComponents));
  }
  return result;
}

const START_POINT_ARC_GAP_ANGLE = 0.25 * Math.PI;

registerVisualizationLayerDefinition({
  identifier: "fontra.startpoint.indicator",
  name: "Startpoint indicator",
  selectionMode: "editing",
  zIndex: 500,
  screenParameters: { radius: 9, strokeWidth: 2 },
  colors: { color: "#989898A0" },
  colorsDarkMode: { color: "#989898A0" },
  draw: (context, positionedGlyph, parameters, model, controller) => {
    const glyph = positionedGlyph.glyph;
    context.strokeStyle = parameters.color;
    context.lineWidth = parameters.strokeWidth;
    const radius = parameters.radius;
    let startPointIndex = 0;
    for (const contourInfo of glyph.path.contourInfo) {
      const startPoint = glyph.path.getPoint(startPointIndex);
      let angle;
      if (startPointIndex < contourInfo.endPoint) {
        const nextPoint = glyph.path.getPoint(startPointIndex + 1);
        const direction = subVectors(nextPoint, startPoint);
        angle = Math.atan2(direction.y, direction.x);
      }
      let startAngle = 0;
      let endAngle = 2 * Math.PI;
      if (angle !== undefined) {
        startAngle += angle + START_POINT_ARC_GAP_ANGLE;
        endAngle += angle - START_POINT_ARC_GAP_ANGLE;
      }
      context.beginPath();
      context.arc(startPoint.x, startPoint.y, radius, startAngle, endAngle, false);
      context.stroke();
      startPointIndex = contourInfo.endPoint + 1;
    }
  },
});

registerVisualizationLayerDefinition({
  identifier: "fontra.handles",
  name: "Bezier handles",
  selectionMode: "editing",
  zIndex: 500,
  screenParameters: { strokeWidth: 1 },
  colors: { color: "#BBB" },
  colorsDarkMode: { color: "#777" },
  draw: (context, positionedGlyph, parameters, model, controller) => {
    const glyph = positionedGlyph.glyph;
    context.strokeStyle = parameters.color;
    context.lineWidth = parameters.strokeWidth;
    for (const [pt1, pt2] of glyph.path.iterHandles()) {
      strokeLine(context, pt1.x, pt1.y, pt2.x, pt2.y);
    }
  },
});

registerVisualizationLayerDefinition({
  identifier: "fontra.nodes",
  name: "Nodes",
  selectionMode: "editing",
  zIndex: 500,
  screenParameters: { cornerSize: 8, smoothSize: 8, handleSize: 6.5 },
  colors: { color: "#BBB" },
  colorsDarkMode: { color: "#BBB" },
  draw: (context, positionedGlyph, parameters, model, controller) => {
    const glyph = positionedGlyph.glyph;
    const cornerSize = parameters.cornerSize;
    const smoothSize = parameters.smoothSize;
    const handleSize = parameters.handleSize;

    context.fillStyle = parameters.color;
    for (const pt of glyph.path.iterPoints()) {
      fillNode(context, pt, cornerSize, smoothSize, handleSize);
    }
  },
});

registerVisualizationLayerDefinition({
  identifier: "fontra.selected.nodes",
  name: "Selected nodes",
  selectionMode: "editing",
  zIndex: 500,
  screenParameters: {
    cornerSize: 8,
    smoothSize: 8,
    handleSize: 6.5,
    strokeWidth: 1,
    hoverStrokeOffset: 4,
    underlayOffset: 2,
  },
  colors: { hoveredColor: "#BBB", selectedColor: "#000", underColor: "#FFFA" },
  colorsDarkMode: { hoveredColor: "#BBB", selectedColor: "#FFF", underColor: "#0008" },
  draw: (context, positionedGlyph, parameters, model, controller) => {
    const glyph = positionedGlyph.glyph;
    const cornerSize = parameters.cornerSize;
    const smoothSize = parameters.smoothSize;
    const handleSize = parameters.handleSize;

    const { point: hoveredPointIndices } = parseSelection(model.hoverSelection);
    const { point: selectedPointIndices } = parseSelection(model.selection);

    // Under layer
    const underlayOffset = parameters.underlayOffset;
    context.fillStyle = parameters.underColor;
    for (const pt of iterPointsByIndex(glyph.path, selectedPointIndices)) {
      fillNode(
        context,
        pt,
        cornerSize + underlayOffset,
        smoothSize + underlayOffset,
        handleSize + underlayOffset
      );
    }
    // Selected nodes
    context.fillStyle = parameters.selectedColor;
    for (const pt of iterPointsByIndex(glyph.path, selectedPointIndices)) {
      fillNode(context, pt, cornerSize, smoothSize, handleSize);
    }
    // Hovered nodes
    context.strokeStyle = parameters.hoveredColor;
    context.lineWidth = parameters.strokeWidth;
    const hoverStrokeOffset = parameters.hoverStrokeOffset;
    for (const pt of iterPointsByIndex(glyph.path, hoveredPointIndices)) {
      strokeNode(
        context,
        pt,
        cornerSize + hoverStrokeOffset,
        smoothSize + hoverStrokeOffset,
        handleSize + hoverStrokeOffset
      );
    }
  },
});

registerVisualizationLayerDefinition({
  identifier: "fontra.connect-insert.point",
  name: "Connect/insert point",
  selectionMode: "editing",
  zIndex: 500,
  screenParameters: {
    connectRadius: 11,
    insertHandlesRadius: 5,
  },
  colors: { color: "#3080FF80" },
  colorsDarkMode: { color: "#50A0FF80" },
  draw: (context, positionedGlyph, parameters, model, controller) => {
    const targetPoint = model.pathConnectTargetPoint;
    const insertHandles = model.pathInsertHandles;
    if (!targetPoint && !insertHandles) {
      return;
    }
    context.fillStyle = parameters.color;
    if (targetPoint) {
      const radius = parameters.connectRadius;
      fillRoundNode(context, targetPoint, 2 * radius);
    }
    for (const point of insertHandles?.points || []) {
      const radius = parameters.insertHandlesRadius;
      fillRoundNode(context, point, 2 * radius);
    }
  },
});

registerVisualizationLayerDefinition({
  identifier: "fontra.edit.background.layers",
  name: "Background glyph layers",
  selectionMode: "editing",
  zIndex: 490,
  screenParameters: {
    strokeWidth: 1,
  },
  colors: { color: "#BBB" },
  colorsDarkMode: { color: "#666" },
  draw: (context, positionedGlyph, parameters, model, controller) => {
    context.lineJoin = "round";
    context.lineWidth = parameters.strokeWidth;
    context.strokeStyle = parameters.color;
    for (const layerGlyph of Object.values(model.backgroundLayerGlyphs || {})) {
      context.stroke(layerGlyph.flattenedPath2d);
    }
  },
});

registerVisualizationLayerDefinition({
  identifier: "fontra.edit.path.under.stroke",
  name: "Underlying edit path stroke",
  selectionMode: "editing",
  zIndex: 490,
  screenParameters: {
    strokeWidth: 3,
  },
  colors: { color: "#FFF6" },
  colorsDarkMode: { color: "#0004" },
  draw: (context, positionedGlyph, parameters, model, controller) => {
    context.lineJoin = "round";
    context.lineWidth = parameters.strokeWidth;
    context.strokeStyle = parameters.color;
    context.stroke(positionedGlyph.glyph.flattenedPath2d);
  },
});

registerVisualizationLayerDefinition({
  identifier: "fontra.edit.path.stroke",
  name: "Edit path stroke",
  selectionMode: "editing",
  zIndex: 500,
  screenParameters: {
    strokeWidth: 1,
  },
  colors: { color: "#000" },
  colorsDarkMode: { color: "#FFF" },
  draw: (context, positionedGlyph, parameters, model, controller) => {
    context.lineJoin = "round";
    context.lineWidth = parameters.strokeWidth;
    context.strokeStyle = parameters.color;
    context.stroke(positionedGlyph.glyph.flattenedPath2d);
  },
});

registerVisualizationLayerDefinition({
  identifier: "fontra.rect.select",
  name: "Rect select",
  selectionMode: "editing",
  zIndex: 500,
  screenParameters: {
    strokeWidth: 1,
    lineDash: [10, 10],
  },
  draw: (context, positionedGlyph, parameters, model, controller) => {
    if (model.selectionRect === undefined) {
      return;
    }
    const selRect = model.selectionRect;
    const x = selRect.xMin;
    const y = selRect.yMin;
    const w = selRect.xMax - x;
    const h = selRect.yMax - y;
    context.lineWidth = parameters.strokeWidth;
    context.strokeStyle = "#000";
    context.strokeRect(x, y, w, h);
    context.strokeStyle = "#FFF";
    context.setLineDash(parameters.lineDash);
    context.strokeRect(x, y, w, h);
  },
});

//
// allGlyphsCleanVisualizationLayerDefinition is not registered, but used
// separately for the "clean" display.
//
export const allGlyphsCleanVisualizationLayerDefinition = {
  identifier: "fontra.all.glyphs",
  name: "All glyphs",
  selectionMode: "all",
  zIndex: 500,
  colors: { fillColor: "#000" },
  colorsDarkMode: { fillColor: "#FFF" },
  draw: (context, positionedGlyph, parameters, model, controller) => {
    context.fillStyle = parameters.fillColor;
    context.fill(positionedGlyph.glyph.flattenedPath2d);
  },
};

// Drawing helpers

function fillNode(context, pt, cornerNodeSize, smoothNodeSize, handleNodeSize) {
  if (!pt.type && !pt.smooth) {
    fillSquareNode(context, pt, cornerNodeSize);
  } else if (!pt.type) {
    fillRoundNode(context, pt, smoothNodeSize);
  } else {
    fillRoundNode(context, pt, handleNodeSize);
  }
}

function strokeNode(context, pt, cornerNodeSize, smoothNodeSize, handleNodeSize) {
  if (!pt.type && !pt.smooth) {
    strokeSquareNode(context, pt, cornerNodeSize);
  } else if (!pt.type) {
    strokeRoundNode(context, pt, smoothNodeSize);
  } else {
    strokeRoundNode(context, pt, handleNodeSize);
  }
}

function fillSquareNode(context, pt, nodeSize) {
  context.fillRect(pt.x - nodeSize / 2, pt.y - nodeSize / 2, nodeSize, nodeSize);
}

function fillRoundNode(context, pt, nodeSize) {
  context.beginPath();
  context.arc(pt.x, pt.y, nodeSize / 2, 0, 2 * Math.PI, false);
  context.fill();
}

function strokeSquareNode(context, pt, nodeSize) {
  context.strokeRect(pt.x - nodeSize / 2, pt.y - nodeSize / 2, nodeSize, nodeSize);
}

function strokeRoundNode(context, pt, nodeSize) {
  context.beginPath();
  context.arc(pt.x, pt.y, nodeSize / 2, 0, 2 * Math.PI, false);
  context.stroke();
}

export function strokeLine(context, x1, y1, x2, y2) {
  context.beginPath();
  context.moveTo(x1, y1);
  context.lineTo(x2, y2);
  context.stroke();
}

function strokeCircle(context, cx, cy, radius) {
  context.beginPath();
  context.arc(cx, cy, radius, 0, 2 * Math.PI, false);
  context.stroke();
}

function drawWithDoubleStroke(
  context,
  path,
  outerLineWidth,
  innerLineWidth,
  strokeStyle,
  fillStyle
) {
  context.lineJoin = "round";
  context.lineWidth = outerLineWidth;
  context.strokeStyle = strokeStyle;
  context.stroke(path);
  context.lineWidth = innerLineWidth;
  context.strokeStyle = "black";
  context.globalCompositeOperation = "destination-out";
  context.stroke(path);
  context.globalCompositeOperation = "source-over";
  context.fillStyle = fillStyle;
  context.fill(path);
}

function lenientUnion(setA, setB) {
  if (!setA) {
    return setB || new Set();
  }
  if (!setB) {
    return setA || new Set();
  }
  return union(setA, setB);
}

function* iterPointsByIndex(path, pointIndices) {
  if (!pointIndices) {
    return;
  }
  for (const index of pointIndices) {
    const pt = path.getPoint(index);
    if (pt !== undefined) {
      yield pt;
    }
  }
}

// {
//   identifier: "fontra.baseline",
//   name: "Baseline",
//   selectionMode: "unselected",  // choice from all, unselected, hovered, selected, editing
//   selectionFilter: (positionedGlyph) => ...some condition...,  // OPTIONAL
//   zIndex: 50
//   screenParameters: {},  // in screen/pixel units
//   glyphParameters: {},  // in glyph units
//   colors: {},
//   colorsDarkMode: {},
//   draw: (context, positionedGlyph, parameters, model, controller) => { /* ... */ },
// }
