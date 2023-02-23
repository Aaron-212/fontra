from fontTools.pens.boundsPen import ControlBoundsPen
from fontTools.pens.pointPen import GuessSmoothPointPen, SegmentToPointPen
from fontTools.pens.recordingPen import RecordingPen
from fontTools.pens.transformPen import TransformPointPen
from fontTools.svgLib import SVGPath
from fontTools.ufoLib.glifLib import readGlyphFromString

from ..backends.designspace import UFOGlyph
from .classes import StaticGlyph
from .packedpath import PackedPathPointPen


def parseClipboard(data):
    if "<svg " in data:
        return parseSVG(data)
    if "<?xml" in data and "<glyph " in data:
        return parseGLIF(data)
    return None


def parseSVG(data):
    data = data.encode("utf-8")
    svgPath = SVGPath.fromstring(data, transform=(1, 0, 0, -1, 0, 0))
    recPen = RecordingPen()
    svgPath.draw(recPen)
    boundsPen = ControlBoundsPen(None)
    recPen.replay(boundsPen)
    xMin, yMin, xMax, yMax = boundsPen.bounds

    pen = PackedPathPointPen()
    tPen = TransformPointPen(pen, (1, 0, 0, 1, 0, -yMin))
    recPen.replay(SegmentToPointPen(GuessSmoothPointPen(tPen)))

    return StaticGlyph(path=pen.getPath(), xAdvance=xMax)


def parseGLIF(data):
    pen = PackedPathPointPen()
    ufoGlyph = UFOGlyph()
    readGlyphFromString(
        data,
        glyphObject=ufoGlyph,
        pointPen=pen,
    )
    return StaticGlyph(
        path=pen.getPath(), components=pen.components, xAdvance=ufoGlyph.width
    )
