import pathlib

from fontTools.misc.roundTools import otRound
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.ufoLib import UFOReader


def numToString(number):
    return str(otRound(number))


def makeSVG(pathString, width, height):
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" '
        f'viewBox="0 0 {width} {height}">'
        f'<path d="{pathString}"/></svg>\n'
    )


thisDir = pathlib.Path(__file__).resolve().parent
ufoPath = thisDir / "fontra-icons.ufo"
imagesDir = thisDir.parent / "src" / "fontra" / "client" / "images"

reader = UFOReader(ufoPath)

glyphSet = reader.getGlyphSet()

iconNames = sorted(
    glyphName
    for glyphName in glyphSet.keys()
    if glyphName != "space" and glyphName[0] not in "._" and len(glyphName) > 1
)

for iconName in iconNames:
    pen = SVGPathPen(glyphSet, numToString)
    glyph = glyphSet[iconName]
    glyph.draw(TransformPen(pen, (1, 0, 0, -1, 0, 800)))
    svgPath = pen.getCommands()
    iconPath = imagesDir / f"{iconName}.svg"
    iconPath.write_text(makeSVG(svgPath, glyph.width, 1000))
