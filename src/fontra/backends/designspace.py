from __future__ import annotations

import asyncio
import logging
import os
import pathlib
from collections import defaultdict
from copy import copy
from dataclasses import asdict, dataclass
from datetime import datetime
from functools import cache, cached_property
from types import SimpleNamespace

import watchfiles
from fontTools.designspaceLib import DesignSpaceDocument
from fontTools.misc.transform import DecomposedTransform
from fontTools.pens.recordingPen import RecordingPointPen
from fontTools.ufoLib import UFOReaderWriter
from fontTools.ufoLib.glifLib import GlyphSet

from ..core.changes import applyChange
from ..core.classes import (
    Component,
    GlobalAxis,
    Layer,
    LocalAxis,
    Source,
    StaticGlyph,
    VariableGlyph,
)
from ..core.packedpath import PackedPathPointPen
from .ufo_utils import extractGlyphNameAndUnicodes

logger = logging.getLogger(__name__)


VARIABLE_COMPONENTS_LIB_KEY = "com.black-foundry.variable-components"
GLYPH_DESIGNSPACE_LIB_KEY = "com.black-foundry.glyph-designspace"
LAYER_NAME_MAPPING_LIB_KEY = "xyz.fontra.layer-names"


infoAttrsToCopy = [
    "unitsPerEm",
    "ascender",
    "descender",
    "xHeight",
    "capHeight",
    "familyName",
    "copyright",
    "year",
]


class DesignspaceBackend:
    @classmethod
    def fromPath(cls, path):
        return cls(DesignSpaceDocument.fromfile(path))

    def __init__(self, dsDoc):
        self.dsDoc = dsDoc
        self.dsDoc.findDefault()
        axes = []
        axisPolePositions = {}
        for dsAxis in self.dsDoc.axes:
            axis = GlobalAxis(
                minValue=dsAxis.minimum,
                defaultValue=dsAxis.default,
                maxValue=dsAxis.maximum,
                label=dsAxis.name,
                name=dsAxis.name,
                tag=dsAxis.tag,
                hidden=dsAxis.hidden,
            )
            if dsAxis.map:
                axis.mapping = [[a, b] for a, b in dsAxis.map]
            axes.append(axis)
            axisPolePositions[dsAxis.name] = (
                dsAxis.map_forward(dsAxis.minimum),
                dsAxis.map_forward(dsAxis.default),
                dsAxis.map_forward(dsAxis.maximum),
            )
        self.axes = axes
        self.axisPolePositions = axisPolePositions
        self.defaultLocation = {
            axisName: polePosition[1]
            for axisName, polePosition in axisPolePositions.items()
        }
        self.loadUFOLayers()
        self.buildFileNameMapping()
        self.glyphMap = getGlyphMapFromGlyphSet(self.defaultDSSource.layer.glyphSet)
        self.savedGlyphModificationTimes = {}

    def close(self):
        pass

    @property
    def defaultDSSource(self):
        return self.dsSources.findItem(isDefault=True)

    @property
    def defaultUFOLayer(self):
        return self.defaultDSSource.layer

    @property
    def defaultReader(self):
        return self.defaultUFOLayer.reader

    @cached_property
    def defaultFontInfo(self):
        fontInfo = UFOFontInfo()
        self.defaultReader.readInfo(fontInfo)
        return fontInfo

    def loadUFOLayers(self):
        self.ufoManager = manager = UFOManager()
        self.dsSources = ItemList()
        self.ufoLayers = ItemList()

        # Using a dict as an order-preserving set:
        ufoPaths = {source.path: None for source in self.dsDoc.sources}
        for ufoPath in ufoPaths:
            reader = manager.getReader(ufoPath)
            for ufoLayerName in reader.getLayerNames():
                self.ufoLayers.append(
                    UFOLayer(manager=manager, path=ufoPath, name=ufoLayerName)
                )

        makeUniqueSourceName = uniqueNameMaker()
        for source in self.dsDoc.sources:
            reader = manager.getReader(source.path)
            defaultLayerName = reader.getDefaultLayerName()
            ufoLayerName = source.layerName or defaultLayerName

            sourceLayer = self.ufoLayers.findItem(path=source.path, name=ufoLayerName)
            sourceStyleName = source.styleName or sourceLayer.fileName
            sourceName = (
                sourceStyleName
                if ufoLayerName == defaultLayerName
                else source.layerName
            )
            sourceName = makeUniqueSourceName(sourceName)

            self.dsSources.append(
                DSSource(
                    name=sourceName,
                    layer=sourceLayer,
                    location={**self.defaultLocation, **source.location},
                    isDefault=source == self.dsDoc.default,
                )
            )

    def buildFileNameMapping(self):
        glifFileNames = {}
        for glyphSet in self.ufoLayers.iterAttrs("glyphSet"):
            for glyphName, fileName in glyphSet.contents.items():
                glifFileNames[fileName] = glyphName
        self.glifFileNames = glifFileNames

    def updateGlyphSetContents(self, glyphSet):
        glyphSet.writeContents()
        glifFileNames = self.glifFileNames
        for glyphName, fileName in glyphSet.contents.items():
            glifFileNames[fileName] = glyphName

    async def getGlyphMap(self):
        return dict(self.glyphMap)

    async def getGlyph(self, glyphName):
        if glyphName not in self.glyphMap:
            return None

        axes = []
        sources = []
        layers = {}
        layerNameMapping = {}

        for dsSource in self.dsSources:
            glyphSet = dsSource.layer.glyphSet
            if glyphName not in glyphSet:
                continue
            sources.append(dsSource.newFontraSource())

        for ufoLayer in self.ufoLayers:
            if glyphName not in ufoLayer.glyphSet:
                continue

            staticGlyph, ufoGlyph = serializeStaticGlyph(ufoLayer.glyphSet, glyphName)
            if ufoLayer == self.defaultUFOLayer:
                localDS = ufoGlyph.lib.get(GLYPH_DESIGNSPACE_LIB_KEY)
                if localDS is not None:
                    axes, localSources = self._unpackLocalDesignSpace(
                        localDS, ufoLayer.path, ufoLayer.name
                    )
                    sources.extend(localSources)
                layerNameMapping = ufoGlyph.lib.get(LAYER_NAME_MAPPING_LIB_KEY, {})
            layers[ufoLayer.fontraLayerName] = Layer(staticGlyph)

        if layerNameMapping:
            for source in sources:
                source.layerName = layerNameMapping.get(
                    source.layerName, source.layerName
                )
            layers = {
                layerNameMapping.get(layerName, layerName): layer
                for layerName, layer in layers.items()
            }

        return VariableGlyph(glyphName, axes=axes, sources=sources, layers=layers)

    def _unpackLocalDesignSpace(self, dsDict, ufoPath, defaultLayerName):
        axes = [
            LocalAxis(
                name=axis["name"],
                minValue=axis["minimum"],
                defaultValue=axis["default"],
                maxValue=axis["maximum"],
            )
            for axis in dsDict["axes"]
        ]
        sources = []
        for source in dsDict.get("sources", ()):
            ufoLayerName = source.get("layername", defaultLayerName)
            sourceName = source.get(
                "name",
                ufoLayerName if ufoLayerName != defaultLayerName else "<default>",
            )
            ufoLayer = self.ufoLayers.findItem(path=ufoPath, name=ufoLayerName)
            sources.append(
                Source(
                    name=sourceName,
                    location=source["location"],
                    layerName=ufoLayer.fontraLayerName,
                )
            )
        return axes, sources

    async def putGlyph(self, glyphName, glyph, unicodes):
        assert isinstance(unicodes, list)
        assert all(isinstance(cp, int) for cp in unicodes)
        self.glyphMap[glyphName] = unicodes

        layerNameMapping = {}
        defaultLayer = self.defaultUFOLayer
        defaultLayerGlyph = None
        if glyphName in defaultLayer.glyphSet:
            defaultLayerGlyph = readGlyphOrCreate(
                defaultLayer.glyphSet, glyphName, unicodes
            )
            layerNameMapping = defaultLayerGlyph.lib.get(LAYER_NAME_MAPPING_LIB_KEY, {})

        revLayerNameMapping = reverseSparseDict(layerNameMapping)

        layerNameMapping = {}
        localAxes = packLocalAxes(glyph.axes)
        localAxisNames = {axis.name for axis in glyph.axes}
        localSources = []

        for source in glyph.sources:
            normalizedFontraLayerName, localSourceDict = self._prepareUFOLayer(
                source, localAxisNames, revLayerNameMapping
            )
            if normalizedFontraLayerName != source.layerName:
                layerNameMapping[normalizedFontraLayerName] = source.layerName
            if localSourceDict is not None:
                localSources.append(localSourceDict)

        localDS = {}
        if localAxes:
            localDS["axes"] = localAxes
        if localSources:
            localDS["sources"] = localSources

        revLayerNameMapping = reverseSparseDict(layerNameMapping)

        modTimes = set()
        usedLayers = set()
        for layerName, layer in glyph.layers.items():
            layerName = revLayerNameMapping.get(layerName, layerName)
            glyphSet = self.ufoLayers.findItem(fontraLayerName=layerName).glyphSet
            usedLayers.add(layerName)
            writeGlyphSetContents = glyphName not in glyphSet

            if (
                glyphSet == self.defaultUFOLayer.glyphSet
                and defaultLayerGlyph is not None
            ):
                layerGlyph = defaultLayerGlyph
            else:
                layerGlyph = readGlyphOrCreate(glyphSet, glyphName, unicodes)

            if glyphSet == self.defaultUFOLayer.glyphSet:
                if localDS:
                    layerGlyph.lib[GLYPH_DESIGNSPACE_LIB_KEY] = localDS
                else:
                    layerGlyph.lib.pop(GLYPH_DESIGNSPACE_LIB_KEY, None)
                if layerNameMapping:
                    layerGlyph.lib[LAYER_NAME_MAPPING_LIB_KEY] = layerNameMapping
                else:
                    layerGlyph.lib.pop(LAYER_NAME_MAPPING_LIB_KEY, None)

            drawPointsFunc = populateUFOLayerGlyph(layerGlyph, layer.glyph)
            glyphSet.writeGlyph(glyphName, layerGlyph, drawPointsFunc=drawPointsFunc)
            if writeGlyphSetContents:
                # FIXME: this is inefficient if we write many glyphs
                self.updateGlyphSetContents(glyphSet)

            modTimes.add(glyphSet.getGLIFModificationTime(glyphName))

        relevantLayerNames = set(
            layer.fontraLayerName
            for layer in self.ufoLayers
            if glyphName in layer.glyphSet
        )
        layersToDelete = relevantLayerNames - usedLayers
        for layerName in layersToDelete:
            glyphSet = self.ufoLayers.findItem(fontraLayerName=layerName).glyphSet
            glyphSet.deleteGlyph(glyphName)
            # FIXME: this is inefficient if we write many glyphs
            self.updateGlyphSetContents(glyphSet)
            modTimes.add(None)

        self.savedGlyphModificationTimes[glyphName] = modTimes

    def _prepareUFOLayer(self, source, localAxisNames, revLayerNameMapping):
        sourceLocation = {**self.defaultLocation, **source.location}
        globalLocation = {
            name: value
            for name, value in sourceLocation.items()
            if name not in localAxisNames
        }

        dsSource = self.dsSources.findItem(
            locationTuple=tuplifyLocation(globalLocation)
        )
        if dsSource is None:
            dsSource = self._createDSSource(source, globalLocation)

        if sourceLocation != globalLocation:
            ufoLayer = self.ufoLayers.findItem(
                fontraLayerName=revLayerNameMapping.get(
                    source.layerName, source.layerName
                )
            )

            if ufoLayer is None:
                ufoPath = dsSource.layer.path
                ufoLayerName = self._newUFOLayer(ufoPath, source.layerName)
                ufoLayer = UFOLayer(
                    manager=self.ufoManager,
                    path=ufoPath,
                    name=ufoLayerName,
                )
                self.ufoLayers.append(ufoLayer)
            else:
                ufoLayerName = ufoLayer.name
            normalizedFontraLayerName = f"{ufoLayer.fileName}/{ufoLayerName}"
            defaultUFOLayerName = ufoLayer.reader.getDefaultLayerName()

            localSourceDict = {}
            if ufoLayerName != defaultUFOLayerName:
                localSourceDict["layername"] = ufoLayerName
            localSourceDict["location"] = source.location
        else:
            normalizedFontraLayerName = dsSource.layer.fontraLayerName
            localSourceDict = None

        return normalizedFontraLayerName, localSourceDict

    def _createDSSource(self, source, globalLocation):
        manager = self.ufoManager
        atPole, notAtPole = splitLocationByPolePosition(
            globalLocation, self.axisPolePositions
        )
        if not notAtPole:
            # Create a whole new UFO
            ufoDir = pathlib.Path(self.defaultUFOLayer.path).parent
            makeUniqueFileName = uniqueNameMaker(p.stem for p in ufoDir.glob("*.ufo"))
            dsFileName = pathlib.Path(self.dsDoc.path).stem
            ufoFileName = makeUniqueFileName(f"{dsFileName}_{source.name}")
            ufoFileName = ufoFileName + ".ufo"
            ufoPath = os.fspath(ufoDir / ufoFileName)
            assert not os.path.exists(ufoPath)
            reader = manager.getReader(ufoPath)  # this creates the UFO
            info = UFOFontInfo()
            for infoAttr in infoAttrsToCopy:
                value = getattr(self.defaultFontInfo, infoAttr, None)
                if value is not None:
                    setattr(info, infoAttr, value)
            _ = reader.getGlyphSet()  # this creates the default layer
            reader.writeLayerContents()
            ufoLayerName = reader.getDefaultLayerName()
            assert os.path.isdir(ufoPath)
        else:
            # Create a new layer in the appropriate existing UFO
            atPole = {**self.defaultLocation, **atPole}
            poleDSSource = self.dsSources.findItem(
                locationTuple=tuplifyLocation(atPole)
            )
            if poleDSSource is None:
                poleDSSource = self.defaultDSSource
            assert poleDSSource is not None
            ufoPath = poleDSSource.layer.path
            ufoLayerName = self._newUFOLayer(poleDSSource.layer.path, source.layerName)

        self.dsDoc.addSourceDescriptor(
            styleName=source.name,
            location=globalLocation,
            path=ufoPath,
            layerName=ufoLayerName,
        )
        self.dsDoc.write(self.dsDoc.path)

        ufoLayer = UFOLayer(
            manager=manager,
            path=ufoPath,
            name=ufoLayerName,
        )

        dsSource = DSSource(
            name=source.name,
            layer=ufoLayer,
            location=globalLocation,
        )
        self.dsSources.append(dsSource)
        self.ufoLayers.append(ufoLayer)

        return dsSource

    def _newUFOLayer(self, path, suggestedLayerName):
        reader = self.ufoManager.getReader(path)
        makeUniqueName = uniqueNameMaker(reader.getLayerNames())
        ufoLayerName = makeUniqueName(suggestedLayerName)
        # Create the new UFO layer now
        _ = self.ufoManager.getGlyphSet(path, ufoLayerName)
        reader.writeLayerContents()
        return ufoLayerName

    async def getGlobalAxes(self):
        return self.axes

    async def getUnitsPerEm(self):
        return self.defaultFontInfo.unitsPerEm

    async def getFontLib(self):
        return self.dsDoc.lib

    async def watchExternalChanges(self):
        ufoPaths = sorted(set(self.ufoLayers.iterAttrs("path")))
        async for changes in watchfiles.awatch(*ufoPaths):
            changes = cleanupWatchFilesChanges(changes)
            changedItems = await self._analyzeExternalChanges(changes)

            glyphMapUpdates = {}

            # TODO: update glyphMap for changed non-new glyphs

            for glyphName in changedItems.newGlyphs:
                try:
                    glifData = self.defaultSourceGlyphSet.getGLIF(glyphName)
                except KeyError:
                    logger.info(f"new glyph '{glyphName}' not found in default source")
                    continue
                gn, unicodes = extractGlyphNameAndUnicodes(glifData)
                glyphMapUpdates[glyphName] = unicodes

            for glyphName in changedItems.deletedGlyphs:
                glyphMapUpdates[glyphName] = None

            externalChange = makeGlyphMapChange(glyphMapUpdates)

            reloadPattern = (
                {"glyphs": dict.fromkeys(changedItems.changedGlyphs)}
                if changedItems.changedGlyphs
                else None
            )

            if externalChange:
                rootObject = {"glyphMap": self.glyphMap}
                applyChange(rootObject, externalChange)

            if externalChange or reloadPattern:
                yield externalChange, reloadPattern

    async def _analyzeExternalChanges(self, changes):
        changedItems = SimpleNamespace(
            changedGlyphs=set(),
            newGlyphs=set(),
            deletedGlyphs=set(),
            rebuildGlyphSetContents=False,
        )
        for change, path in changes:
            _, fileSuffix = os.path.splitext(path)

            if fileSuffix == ".glif":
                self._analyzeExternalGlyphChanges(change, path, changedItems)

        if changedItems.rebuildGlyphSetContents:
            #
            # In some cases we're responding to a changed glyph while the
            # contents.plist hasn't finished writing yet. Let's pause a little
            # bit and hope for the best.
            #
            # This is obviously not a solid solution, and I'm not sure there is
            # one, given we don't know whether new .glif files written before or
            # after the corresponding contents.plist file. And even if we do know,
            # the amount of time between the two events can be arbitrarily long,
            # at least in theory, when many new glyphs are written at once.
            #
            # TODO: come up with a better solution.
            #
            await asyncio.sleep(0.15)
            for glyphSet in self.ufoLayers.iterAttrs("glyphSet"):
                glyphSet.rebuildContents()

        return changedItems

    def _analyzeExternalGlyphChanges(self, change, path, changedItems):
        fileName = os.path.basename(path)
        glyphName = self.glifFileNames.get(fileName)

        if change == watchfiles.Change.deleted:
            # Deleted glyph
            changedItems.rebuildGlyphSetContents = True
            if path.startswith(os.path.join(self.dsDoc.default.path, "glyphs/")):
                # The glyph was deleted from the default source,
                # do a full delete
                del self.glifFileNames[fileName]
                changedItems.deletedGlyphs.add(glyphName)
            # else:
            # The glyph was deleted from a non-default source,
            # just reload.
        elif change == watchfiles.Change.added:
            # New glyph
            changedItems.rebuildGlyphSetContents = True
            if glyphName is None:
                with open(path, "rb") as f:
                    glyphName, _ = extractGlyphNameAndUnicodes(f.read())
                self.glifFileNames[fileName] = glyphName
                changedItems.newGlyphs.add(glyphName)
                return
        else:
            # Changed glyph
            assert change == watchfiles.Change.modified

        if glyphName is None:
            return

        if os.path.exists(path):
            mtime = os.stat(path).st_mtime
            # Round-trip through datetime, as that's effectively what is happening
            # in getGLIFModificationTime, deep down in the fs package. It makes sure
            # we're comparing timestamps that are actually comparable, as they're
            # rounded somewhat, compared to the raw st_mtime timestamp.
            mtime = datetime.fromtimestamp(mtime).timestamp()
        else:
            mtime = None
        savedMTimes = self.savedGlyphModificationTimes.get(glyphName, ())
        if mtime not in savedMTimes:
            logger.info(f"external change '{glyphName}'")
            changedItems.changedGlyphs.add(glyphName)


def makeGlyphMapChange(glyphMapUpdates):
    if not glyphMapUpdates:
        return None
    changes = [
        {"f": "=", "a": [glyphName, unicodes]}
        for glyphName, unicodes in glyphMapUpdates.items()
        if unicodes is not None
    ] + [
        {"f": "d", "a": [glyphName]}
        for glyphName, unicodes in glyphMapUpdates.items()
        if unicodes is None
    ]
    glyphMapChange = {"p": ["glyphMap"]}
    if len(changes) == 1:
        glyphMapChange.update(changes[0])
    else:
        glyphMapChange["c"] = changes
    return glyphMapChange


class UFOBackend:
    @classmethod
    def fromPath(cls, path):
        dsDoc = DesignSpaceDocument()
        dsDoc.addSourceDescriptor(path=os.fspath(path), styleName="default")
        return DesignspaceBackend(dsDoc)


class UFOGlyph:
    unicodes = ()
    width = 0


class UFOFontInfo:
    unitsPerEm = 1000


class UFOManager:
    @cache
    def getReader(self, path):
        return UFOReaderWriter(path)

    @cache
    def getGlyphSet(self, path, layerName):
        return self.getReader(path).getGlyphSet(layerName, defaultLayer=False)


@dataclass(kw_only=True, frozen=True)
class DSSource:
    name: str
    layer: UFOLayer
    location: dict[str, float]
    isDefault: bool = False

    @cached_property
    def locationTuple(self):
        return tuplifyLocation(self.location)

    def newFontraSource(self):
        return Source(
            name=self.name,
            location=copy(self.location),
            layerName=self.layer.fontraLayerName,
        )


@dataclass(kw_only=True, frozen=True)
class UFOLayer:
    manager: UFOManager
    path: str
    name: str

    @cached_property
    def fileName(self):
        return os.path.splitext(os.path.basename(self.path))[0]

    @cached_property
    def fontraLayerName(self):
        return f"{self.fileName}/{self.name}"

    @cached_property
    def reader(self):
        return self.manager.getReader(self.path)

    @cached_property
    def glyphSet(self):
        return self.manager.getGlyphSet(self.path, self.name)


class ItemList:
    def __init__(self):
        self.items = []
        self.invalidateCache()

    def __iter__(self):
        return iter(self.items)

    def append(self, item):
        self.items.append(item)
        self.invalidateCache()

    def invalidateCache(self):
        self._mappings = {}

    def findItem(self, **kwargs):
        items = self.findItems(**kwargs)
        return items[0] if items else None

    def findItems(self, **kwargs):
        attrTuple = tuple(kwargs.keys())
        valueTuple = tuple(kwargs.values())
        keyMapping = self._mappings.get(attrTuple)
        if keyMapping is None:
            keyMapping = defaultdict(list)
            for item in self.items:
                itemValueTuple = tuple(
                    getattr(item, attrName) for attrName in attrTuple
                )
                keyMapping[itemValueTuple].append(item)
            self._mappings[attrTuple] = dict(keyMapping)
        return keyMapping.get(valueTuple)

    def iterAttrs(self, attrName):
        for item in self:
            yield getattr(item, attrName)


def serializeGlyphLayers(glyphSets, glyphName, sourceLayerName):
    layers = {}
    sourceLayerGlyph = None
    for layerName, glyphSet in glyphSets.items():
        if glyphName in glyphSet:
            staticGlyph, glyph = serializeStaticGlyph(glyphSet, glyphName)
            layers[layerName] = Layer(glyph=staticGlyph)
            if layerName == sourceLayerName:
                sourceLayerGlyph = glyph
    return layers, sourceLayerGlyph


def serializeStaticGlyph(glyphSet, glyphName):
    glyph = UFOGlyph()
    glyph.lib = {}
    pen = PackedPathPointPen()
    glyphSet.readGlyph(glyphName, glyph, pen, validate=False)
    components = [*pen.components] + unpackVariableComponents(glyph.lib)
    staticGlyph = StaticGlyph(
        path=pen.getPath(), components=components, xAdvance=glyph.width
    )
    # TODO: anchors
    # TODO: yAdvance, verticalOrigin
    return staticGlyph, glyph


def unpackVariableComponents(lib):
    components = []
    for componentDict in lib.get(VARIABLE_COMPONENTS_LIB_KEY, ()):
        glyphName = componentDict["base"]
        transformationDict = componentDict.get("transformation", {})
        transformation = DecomposedTransform(**transformationDict)
        location = componentDict.get("location", {})
        components.append(Component(glyphName, transformation, location))
    return components


def readGlyphOrCreate(
    glyphSet: GlyphSet,
    glyphName: str,
    unicodes: list[int],
):
    layerGlyph = UFOGlyph()
    layerGlyph.lib = {}
    if glyphName in glyphSet:
        # We read the existing glyph so we don't lose any data that
        # Fontra doesn't understand
        glyphSet.readGlyph(glyphName, layerGlyph, validate=False)
    layerGlyph.unicodes = unicodes
    return layerGlyph


def populateUFOLayerGlyph(layerGlyph: UFOGlyph, staticGlyph: StaticGlyph) -> None:
    pen = RecordingPointPen()
    layerGlyph.width = staticGlyph.xAdvance
    layerGlyph.height = staticGlyph.yAdvance
    staticGlyph.path.drawPoints(pen)
    variableComponents = []
    for component in staticGlyph.components:
        if component.location:
            # It's a variable component
            varCoDict = {"base": component.name, "location": component.location}
            if component.transformation != DecomposedTransform():
                varCoDict["transformation"] = asdict(component.transformation)
            variableComponents.append(varCoDict)
        else:
            # It's a regular component
            pen.addComponent(
                component.name,
                cleanupTransform(component.transformation.toTransform()),
            )

    if variableComponents:
        layerGlyph.lib[VARIABLE_COMPONENTS_LIB_KEY] = variableComponents
    else:
        layerGlyph.lib.pop(VARIABLE_COMPONENTS_LIB_KEY, None)

    return pen.replay


def getGlyphMapFromGlyphSet(glyphSet):
    glyphMap = {}
    for glyphName in glyphSet.keys():
        glifData = glyphSet.getGLIF(glyphName)
        gn, unicodes = extractGlyphNameAndUnicodes(glifData)
        assert gn == glyphName, (gn, glyphName)
        glyphMap[glyphName] = unicodes
    return glyphMap


def uniqueNameMaker(existingNames=()):
    usedNames = set(existingNames)

    def makeUniqueName(name):
        count = 0
        uniqueName = name
        while uniqueName in usedNames:
            count += 1
            uniqueName = f"{name}#{count}"
        usedNames.add(uniqueName)
        return uniqueName

    return makeUniqueName


def cleanupTransform(t):
    """Convert any integer float values into ints. This is to prevent glifLib
    from writing float values that can be integers."""
    return tuple(int(v) if int(v) == v else v for v in t)


def cleanupWatchFilesChanges(changes):
    # If a path is mentioned with more than one event type, we pick the most
    # appropriate one among them:
    # - if there is a delete event and the path does not exist: delete it is
    # - else: keep the lowest sorted event (order: added, modified, deleted)
    perPath = {}
    for change, path in sorted(changes):
        if path in perPath:
            if change == watchfiles.Change.deleted and not os.path.exists(path):
                # File doesn't exist, event to "deleted"
                perPath[path] = watchfiles.Change.deleted
            # else: keep the first event
        else:
            perPath[path] = change
    return [(change, path) for path, change in perPath.items()]


def tuplifyLocation(loc):
    # TODO: find good place to share this (duplicated from opentype.py)
    return tuple(sorted(loc.items()))


def splitLocationByPolePosition(location, poles):
    atPole = {}
    notAtPole = {}
    for name, value in location.items():
        if value in poles.get(name, ()):
            atPole[name] = value
        else:
            notAtPole[name] = value
    return atPole, notAtPole


def packLocalAxes(axes):
    return [
        dict(
            name=axis.name,
            minimum=axis.minValue,
            default=axis.defaultValue,
            maximum=axis.maxValue,
        )
        for axis in axes
    ]


def reverseSparseDict(d):
    return {v: k for k, v in d.items() if k != v}
