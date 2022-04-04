import re
from fontTools.ufoLib.filenames import userNameToFileName


_glyphNamePat = re.compile(rb'<glyph\s+name\s*=\s*"([^"]+)"')
_unicodePat = re.compile(rb'<unicode\s+hex\s*=\s*"([^"]+)"')


def extractGlyphNameAndUnicodes(data, fileName=None):
    m = _glyphNamePat.search(data)
    if m is None:
        raise ValueError(f"invalid .glif file, glyph name not found ({fileName})")
    glyphName = m.group(1).decode("utf-8")
    if fileName is not None:
        refFileName = userNameToFileName(glyphName, suffix=".glif")
        if refFileName != fileName:
            logger.warning(
                "actual file name does not match predicted file name: "
                f"{refFileName} {fileName} {glyphName}"
            )
    unicodes = [int(u, 16) for u in _unicodePat.findall(data)]
    return glyphName, unicodes
