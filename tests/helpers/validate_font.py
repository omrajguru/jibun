"""Load a font with fontTools, force-decompile every table, and print a JSON summary."""
import io
import json
import sys

from fontTools.ttLib import TTFont


def main(path):
    font = TTFont(path)
    summary = {"tables": sorted(font.keys()), "flavor": font.flavor}
    for tag in font.keys():
        font[tag]  # decompiles, raising on malformed data
    summary["numGlyphs"] = font["maxp"].numGlyphs
    summary["glyphOrder"] = font.getGlyphOrder()[:10]
    cmap = font.getBestCmap()
    summary["cmapSize"] = len(cmap)
    for t in ("GSUB", "GPOS"):
        if t in font:
            tbl = font[t].table
            summary[t] = {
                "features": sorted({fr.FeatureTag for fr in tbl.FeatureList.FeatureRecord}),
                "scripts": sorted({sr.ScriptTag for sr in tbl.ScriptList.ScriptRecord}),
                "lookups": len(tbl.LookupList.Lookup),
            }
    if "glyf" in font:
        glyf = font["glyf"]
        hmtx = font["hmtx"]
        bad = []
        for name in font.getGlyphOrder():
            g = glyf[name]
            if g.numberOfContours and g.numberOfContours > 0:
                adv, lsb = hmtx[name]
                if lsb != g.xMin:
                    bad.append(name)
        summary["lsbMismatch"] = bad[:10]
    # Round-trip: recompile everything from the decompiled objects.
    buf = io.BytesIO()
    font.flavor = None
    font.save(buf)
    summary["roundTripBytes"] = len(buf.getvalue())
    head = font["head"]
    summary["unitsPerEm"] = head.unitsPerEm
    summary["name"] = font["name"].getDebugName(4)
    print(json.dumps(summary))


if __name__ == "__main__":
    main(sys.argv[1])
