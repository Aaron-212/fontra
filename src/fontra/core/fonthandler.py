import asyncio
import functools
import logging
import traceback
from collections import UserDict, defaultdict
from contextlib import contextmanager
from copy import deepcopy
from dataclasses import dataclass
from typing import Any

from .changes import (
    applyChange,
    collectChangePaths,
    filterChangePattern,
    matchChangePattern,
    patternDifference,
    patternFromPath,
    patternIntersect,
    patternUnion,
)
from .classes import Font
from .clipboard import parseClipboard
from .glyphnames import getSuggestedGlyphName, getUnicodeFromGlyphName
from .lrucache import LRUCache

logger = logging.getLogger(__name__)


CHANGES_PATTERN_KEY = "changes-match-pattern"
LIVE_CHANGES_PATTERN_KEY = "live-changes-match-pattern"


def remoteMethod(method):
    method.fontraRemoteMethod = True
    return method


backendAttrMapping = [
    ("axes", "GlobalAxes"),
    ("glyphMap", "GlyphMap"),
    ("lib", "FontLib"),
    ("unitsPerEm", "UnitsPerEm"),
]

backendGetterNames = {attr: "get" + baseName for attr, baseName in backendAttrMapping}
backendSetterNames = {attr: "set" + baseName for attr, baseName in backendAttrMapping}
backendDeleterNames = {
    attr: "delete" + baseName for attr, baseName in backendAttrMapping
}


@dataclass
class FontHandler:
    backend: Any  # TODO: need Backend protocol
    readOnly: bool = False

    def __post_init__(self):
        if not hasattr(self.backend, "putGlyph"):
            self.readOnly = True
        self.connections = set()
        self.glyphUsedBy = {}
        self.glyphMadeOf = {}
        self.clientData = defaultdict(dict)
        self.localData = LRUCache()
        self._dataScheduledForWriting = {}

    async def startTasks(self):
        if hasattr(self.backend, "watchExternalChanges"):
            self._watcherTask = asyncio.create_task(self.processExternalChanges())
            self._watcherTask.add_done_callback(taskDoneHelperWatchFiles)
        self._processWritesError = None
        self._processWritesEvent = asyncio.Event()
        self._processWritesTask = asyncio.create_task(self.processWrites())
        self._processWritesTask.add_done_callback(self._processWritesTaskDone)
        self._processWritesTask.add_done_callback(taskDoneHelper)
        self._writingInProgressEvent = asyncio.Event()
        self._writingInProgressEvent.set()

    async def close(self):
        self.backend.close()
        if hasattr(self, "_watcherTask"):
            self._watcherTask.cancel()
        if hasattr(self, "_processWritesTask"):
            await self.finishWriting()  # shield for cancel?
            self._processWritesTask.cancel()

    async def processExternalChanges(self):
        async for change, reloadPattern in self.backend.watchExternalChanges():
            try:
                if change is not None:
                    await self.updateLocalDataWithExternalChange(change)
                    await self.broadcastChange(change, None, False)
                if reloadPattern is not None:
                    await self.reloadData(reloadPattern)
            except Exception as e:
                logger.error("exception in external changes watcher: %r", e)
                traceback.print_exc()

    def _processWritesTaskDone(self, task):
        # Signal that the write-"thread" is no longer running
        self._dataScheduledForWriting = None

    async def finishWriting(self):
        if self._processWritesError is not None:
            raise self._processWritesError
        await self._writingInProgressEvent.wait()

    async def processWrites(self):
        while True:
            await self._processWritesEvent.wait()
            try:
                await self._processWritesOneCycle()
            except Exception as e:
                self._processWritesError = e
                raise
            finally:
                self._processWritesEvent.clear()
                self._writingInProgressEvent.set()

    async def _processWritesOneCycle(self):
        while self._dataScheduledForWriting:
            writeKey, (writeFunc, connection) = popFirstItem(
                self._dataScheduledForWriting
            )
            reloadPattern = _writeKeyToPattern(writeKey)
            logger.info(f"write {writeKey} to backend")
            try:
                errorMessage = await writeFunc()
            except Exception as e:
                logger.error("exception while writing data: %r", e)
                traceback.print_exc()
                await self.reloadData(reloadPattern)
                if connection is not None:
                    await connection.proxy.messageFromServer(
                        "The data could not be saved due to an error.",
                        f"The edit has been reverted.\n\n{e!r}",
                    )
                else:
                    # No connection to inform, let's error
                    raise
            else:
                if errorMessage:
                    messageDetail = f"The edit has been reverted.\n\n{errorMessage}"
                    try:
                        await self.reloadData(reloadPattern)
                    except Exception as e:
                        messageDetail = (
                            f"{errorMessage}\n\n"
                            "The edit could not be reverted due to an additional error."
                            f"\n\n{e!r}"
                        )
                    if connection is not None:
                        await connection.proxy.messageFromServer(
                            "The data could not be saved.",
                            messageDetail,
                        )
                    else:
                        # This ideally can't happen
                        assert False, errorMessage
            await asyncio.sleep(0)

    @contextmanager
    def useConnection(self, connection):
        self.connections.add(connection)
        try:
            yield
        finally:
            self.connections.remove(connection)

    @remoteMethod
    async def getGlyph(self, glyphName, *, connection=None):
        glyph = self.localData.get(("glyphs", glyphName))
        if glyph is None:
            glyph = await self._getGlyph(glyphName)
            self.localData[("glyphs", glyphName)] = glyph
        return glyph

    def _getGlyph(self, glyphName):
        return asyncio.create_task(self._getGlyphFromBackend(glyphName))

    async def _getGlyphFromBackend(self, glyphName):
        glyph = await self.backend.getGlyph(glyphName)
        if glyph is not None:
            self.updateGlyphDependencies(glyphName, glyph)
        return glyph

    async def getData(self, key):
        data = self.localData.get(key)
        if data is None:
            data = await self._getData(key)
            self.localData[key] = data
        return data

    async def _getData(self, key):
        getterName = backendGetterNames[key]
        return await getattr(self.backend, getterName)()

    @remoteMethod
    async def getGlyphMap(self, *, connection):
        return await self.getData("glyphMap")

    @remoteMethod
    async def getGlobalAxes(self, *, connection):
        return await self.getData("axes")

    @remoteMethod
    async def getUnitsPerEm(self, *, connection):
        return await self.getData("unitsPerEm")

    @remoteMethod
    async def getFontLib(self, *, connection):
        return await self.getData("lib")

    def _getClientData(self, connection, key, default=None):
        return self.clientData[connection.clientUUID].get(key, default)

    def _setClientData(self, connection, key, value):
        self.clientData[connection.clientUUID][key] = value

    @remoteMethod
    async def subscribeChanges(self, pathOrPattern, wantLiveChanges, *, connection):
        pattern = _ensurePattern(pathOrPattern)
        self._adjustMatchPattern(patternUnion, pattern, wantLiveChanges, connection)

    @remoteMethod
    async def unsubscribeChanges(self, pathOrPattern, wantLiveChanges, *, connection):
        pattern = _ensurePattern(pathOrPattern)
        self._adjustMatchPattern(
            patternDifference, pattern, wantLiveChanges, connection
        )

    def _adjustMatchPattern(self, func, pathOrPattern, wantLiveChanges, connection):
        key = LIVE_CHANGES_PATTERN_KEY if wantLiveChanges else CHANGES_PATTERN_KEY
        matchPattern = self._getClientData(connection, key, {})
        self._setClientData(connection, key, func(matchPattern, pathOrPattern))

    @remoteMethod
    async def editIncremental(self, liveChange, *, connection):
        await self.broadcastChange(liveChange, connection, True)

    @remoteMethod
    async def editFinal(
        self, finalChange, rollbackChange, editLabel, broadcast=False, *, connection
    ):
        # TODO: use finalChange, rollbackChange, editLabel for history recording
        # TODO: locking/checking
        await self.updateLocalDataAndWriteToBackend(finalChange, connection)
        # return {"error": "computer says no"}
        if broadcast:
            await self.broadcastChange(finalChange, connection, False)

    async def broadcastChange(self, change, sourceConnection, isLiveChange):
        if isLiveChange:
            matchPatternKeys = [LIVE_CHANGES_PATTERN_KEY]
        else:
            matchPatternKeys = [LIVE_CHANGES_PATTERN_KEY, CHANGES_PATTERN_KEY]

        connections = [
            connection
            for connection in self.connections
            if connection != sourceConnection
            and any(
                matchChangePattern(change, self._getClientData(connection, k, {}))
                for k in matchPatternKeys
            )
        ]

        await asyncio.gather(
            *[connection.proxy.externalChange(change) for connection in connections]
        )

    async def updateLocalDataWithExternalChange(self, change):
        await self._updateLocalDataAndWriteToBackend(change, None, True)

    async def updateLocalDataAndWriteToBackend(self, change, sourceConnection):
        await self._updateLocalDataAndWriteToBackend(change, sourceConnection, False)

    async def _updateLocalDataAndWriteToBackend(
        self, change, sourceConnection, isExternalChange
    ):
        if isExternalChange:
            # The change is coming from the backend:
            # - Only apply the change to data we already have
            # - Loading it from the backend would give as the already
            #   changed data, for which the change isn't valid
            # So: filter the change based on the data we have
            localPattern = self._getLocalDataPattern()
            change = filterChangePattern(change, localPattern)
            if change is None:
                return

        rootKeys, rootObject = await self._prepareRootObject(change)
        applyChange(rootObject, change)
        await self._updateLocalData(
            rootKeys,
            rootObject,
            sourceConnection,
            not isExternalChange and not self.readOnly,
        )

    def _getLocalDataPattern(self):
        localPattern = {}
        for key in self.localData:
            if isinstance(key, tuple):
                rootKey, subKey = key
                subPattern = localPattern.setdefault(rootKey, {})
                subPattern[subKey] = None
            else:
                localPattern[key] = None
        return localPattern

    async def _prepareRootObject(self, change):
        rootObject = Font()
        rootKeys = [p[0] for p in collectChangePaths(change, 1)]
        for rootKey in rootKeys:
            if rootKey == "glyphs":
                glyphNames = [
                    glyphName
                    for key, glyphName in collectChangePaths(change, 2)
                    if key == "glyphs"
                ]
                glyphSet = {
                    glyphName: await self.getGlyph(glyphName)
                    for glyphName in glyphNames
                }
                glyphSet = DictSetDelTracker(glyphSet)
                rootObject.glyphs = glyphSet
            else:
                setattr(rootObject, rootKey, await self.getData(rootKey))

        rootObject._trackAssignedAttributeNames()
        return rootKeys, rootObject

    async def _updateLocalData(
        self, rootKeys, rootObject, sourceConnection, writeToBackEnd
    ):
        for rootKey in rootKeys + sorted(rootObject._assignedAttributeNames):
            if rootKey == "glyphs":
                glyphSet = rootObject.glyphs
                glyphMap = await self.getData("glyphMap")
                for glyphName in sorted(glyphSet.keys()):
                    writeKey = ("glyphs", glyphName)
                    if glyphName in glyphSet.newKeys:
                        self.localData[writeKey] = glyphSet[glyphName]
                    if not writeToBackEnd:
                        continue
                    writeFunc = functools.partial(
                        self.backend.putGlyph,
                        glyphName,
                        deepcopy(glyphSet[glyphName]),
                        glyphMap.get(glyphName, []),
                    )
                    await self.scheduleDataWrite(writeKey, writeFunc, sourceConnection)
                for glyphName in sorted(glyphSet.deletedKeys):
                    writeKey = ("glyphs", glyphName)
                    _ = self.localData.pop(writeKey, None)
                    if not writeToBackEnd:
                        continue
                    writeFunc = functools.partial(self.backend.deleteGlyph, glyphName)
                    await self.scheduleDataWrite(writeKey, writeFunc, sourceConnection)
            else:
                if rootKey in rootObject._assignedAttributeNames:
                    self.localData[rootKey] = getattr(rootObject, rootKey)
                if not writeToBackEnd:
                    continue
                method = getattr(self.backend, backendSetterNames[rootKey], None)
                if method is None:
                    logger.info(f"No backend write method found for {rootKey}")
                    continue
                writeFunc = functools.partial(method, deepcopy(rootObject[rootKey]))
                await self.scheduleDataWrite(rootKey, writeFunc, sourceConnection)

    async def scheduleDataWrite(self, writeKey, writeFunc, connection):
        if self._dataScheduledForWriting is None:
            # The write-"thread" is no longer running
            await self.reloadData(_writeKeyToPattern(writeKey))
            await connection.proxy.messageFromServer(
                "The data could not be saved.",
                "The edit has been reverted.\n\n"  # no trailing comma
                "The Fontra server got itself into trouble, please contact an admin.",
            )
            return
        shouldSignal = not self._dataScheduledForWriting
        self._dataScheduledForWriting[writeKey] = (writeFunc, connection)
        if shouldSignal:
            self._processWritesEvent.set()  # write: go!
            self._writingInProgressEvent.clear()

    def iterGlyphMadeOf(self, glyphName):
        for dependantGlyphName in self.glyphMadeOf.get(glyphName, ()):
            yield dependantGlyphName
            yield from self.iterGlyphMadeOf(dependantGlyphName)

    def iterGlyphUsedBy(self, glyphName):
        for dependantGlyphName in self.glyphUsedBy.get(glyphName, ()):
            yield dependantGlyphName
            yield from self.iterGlyphUsedBy(dependantGlyphName)

    def updateGlyphDependencies(self, glyphName, glyph):
        # Zap previous used-by data for this glyph, if any
        for componentName in self.glyphMadeOf.get(glyphName, ()):
            if componentName in self.glyphUsedBy:
                self.glyphUsedBy[componentName].discard(glyphName)
        componentNames = set(_iterAllComponentNames(glyph))
        if componentNames:
            self.glyphMadeOf[glyphName] = componentNames
        elif glyphName in self.glyphMadeOf:
            del self.glyphMadeOf[glyphName]
        for componentName in componentNames:
            if componentName not in self.glyphUsedBy:
                self.glyphUsedBy[componentName] = set()
            self.glyphUsedBy[componentName].add(glyphName)

    async def reloadData(self, reloadPattern):
        # Drop local data to ensure it gets reloaded from the backend
        for rootKey, value in reloadPattern.items():
            if rootKey == "glyphs":
                for glyphName in value:
                    self.localData.pop(("glyphs", glyphName), None)
            else:
                self.localData.pop(rootKey, None)

        logger.info(f"broadcasting external changes: {reloadPattern}")

        connections = []
        for connection in self.connections:
            subscribePattern = self._getCombinedSubscribePattern(connection)
            connReloadPattern = patternIntersect(subscribePattern, reloadPattern)
            if connReloadPattern:
                connections.append((connection, connReloadPattern))
        await asyncio.gather(
            *[
                connection.proxy.reloadData(connReloadPattern)
                for connection, connReloadPattern in connections
            ]
        )

    def _getCombinedSubscribePattern(self, connection):
        patternA, patternB = [
            self._getClientData(connection, key, {})
            for key in [LIVE_CHANGES_PATTERN_KEY, CHANGES_PATTERN_KEY]
        ]
        return patternUnion(patternA, patternB)

    @remoteMethod
    async def getSuggestedGlyphName(self, codePoint, *, connection):
        return getSuggestedGlyphName(codePoint)

    @remoteMethod
    async def getUnicodeFromGlyphName(self, glyphName, *, connection):
        return getUnicodeFromGlyphName(glyphName)

    @remoteMethod
    async def parseClipboard(self, data, *, connection):
        return parseClipboard(data)


def _iterAllComponentNames(glyph):
    for layer in glyph.layers:
        for compo in layer.glyph.components:
            yield compo.name


def popFirstItem(d):
    key = next(iter(d))
    return (key, d.pop(key))


def taskDoneHelper(task):
    if not task.cancelled() and task.exception() is not None:
        logger.exception(
            f"fatal exception in asyncio task {task}", exc_info=task.exception()
        )


def taskDoneHelperWatchFiles(task):
    if not task.cancelled() and task.exception() is not None:
        exception = task.exception()
        if isinstance(exception, RuntimeError) and str(exception) == "Already borrowed":
            # Suppress RuntimeError("Already borrowed"), to work around this watchfiles
            # issue: https://github.com/samuelcolvin/watchfiles/issues/200
            return
        logger.exception(f"fatal exception in asyncio task {task}", exc_info=exception)


def _writeKeyToPattern(writeKey):
    if not isinstance(writeKey, tuple):
        writeKey = (writeKey,)
    return patternFromPath(writeKey)


def _ensurePattern(pathOrPattern):
    return (
        patternFromPath(pathOrPattern)
        if isinstance(pathOrPattern, list)
        else pathOrPattern
    )


class DictSetDelTracker(UserDict):
    def __init__(self, data):
        super().__init__()
        self.data = data  # no copy
        self.newKeys = set()
        self.deletedKeys = set()

    def __setitem__(self, key, value):
        isNewItem = key not in self
        super().__setitem__(key, value)
        if isNewItem:
            self.newKeys.add(key)
            self.deletedKeys.discard(key)

    def __delitem__(self, key):
        _ = self.pop(key, None)
        self.deletedKeys.add(key)
        self.newKeys.discard(key)
