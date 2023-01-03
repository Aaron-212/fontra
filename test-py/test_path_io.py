from dataclasses import asdict
import pytest
from fontra.core.classes import from_dict
from fontra.core.packedpath import PackedPath, PackedPathPointPen


pathTestData = [
    {
        "contourInfo": [{"endPoint": 3, "isClosed": True}],
        "coordinates": [60, 0, 110, 0, 110, 120, 60, 120],
        "pointTypes": [0, 0, 0, 0],
    },
    {
        "coordinates": [
            232,
            -10,
            338,
            -10,
            403,
            38,
            403,
            182,
            403,
            700,
            363,
            700,
            363,
            182,
            363,
            60,
            313,
            26,
            232,
            26,
            151,
            26,
            100,
            60,
            100,
            182,
            100,
            280,
            60,
            280,
            60,
            182,
            60,
            38,
            124,
            -10,
        ],
        "pointTypes": [
            8,
            2,
            2,
            8,
            0,
            0,
            8,
            2,
            2,
            8,
            2,
            2,
            8,
            0,
            0,
            8,
            2,
            2,
        ],
        "contourInfo": [{"endPoint": 17, "isClosed": True}],
    },
    {
        "coordinates": [
            338,
            -10,
            403,
            38,
            403,
            182,
            403,
            700,
            232,
            -10,
        ],
        "pointTypes": [
            2,
            2,
            8,
            0,
            8,
        ],
        "contourInfo": [{"endPoint": 4, "isClosed": True}],
    },
    {
        "coordinates": [
            232,
            -10,
            338,
            -10,
            403,
            38,
            403,
            182,
            403,
            700,
        ],
        "pointTypes": [
            8,
            2,
            2,
            8,
            0,
        ],
        "contourInfo": [{"endPoint": 4, "isClosed": False}],
    },
]


@pytest.mark.parametrize("path", pathTestData)
async def test_packedPathPointPenRoundTrip(path):
    path = from_dict(PackedPath, path)
    pen = PackedPathPointPen()
    path.drawPoints(pen)
    repackedPath = pen.getPath()
    assert path == repackedPath
    assert asdict(path) == asdict(repackedPath)


@pytest.mark.parametrize("path", pathTestData)
async def test_unpackPathRoundTrip(path):
    path = from_dict(PackedPath, path)
    unpackedPath = path.unpackedContours()
    repackedPath = PackedPath.fromUnpackedContours(unpackedPath)
    assert path == repackedPath
    assert asdict(path) == asdict(repackedPath)
