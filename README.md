# SewCAD — Women's 2D/3D Garment CAD, Draping & 1:1 Production

Browser-based 2D/3D garment pattern-drafting CAD, contoured women's 3D dress-form draping (XPBD cloth + dart/seam physics), Three.js PBR textile studio, `.stl` object-cover unwrapping, and true-scale 1:1 physical cut-and-sew export (`Tiled PDF` with Assembly Map, `1:1 SVG`, `DXF`, `JSON`).

- **Women's Garment Blocks & Cup-Aware FBA**: Fitted Bodice Sloper (Bust + Waist Darts + Set-In Sleeves), 6-Panel Princess-Seam Bodice / Bustier, Fit-and-Flare Dress, A-Line Skirt + Waistband, Tailored Pencil Skirt, and High-Waisted Wide-Leg Trousers—with automatic **Underbust / Cup-Projection Full Bust Adjustment (FBA)** that scales front bust darts, princess curves, and over-bust length without distorting shoulder or back frame width (plus Tee, Hoodie, Work Pants, Gusseted Tote Bag, and Custom 3D `.STL` Cover).
- **Contoured Women's 3D Dress Form & Auto-Save**: Standard women's size presets (`XS / US 2` through `2X / US 22–24W`) plus custom **Full Bust**, **Underbust**, **Waist**, **High Hip**, **Full Hip**, **Shoulder**, **Bust Span**, **HPS to Bust**, and **Height**, live **Auto-fit garment to form**, and automatic local browser draft persistence.
- **Home-Printer Friendly 1:1 Exports**: Multi-page Letter/A4/Tabloid/A0 `Tiled PDF` with a **Page-1 Tile Assembly Map**, **blank-tile skipping**, corner alignment diamonds, `2.00 × 2.00 in` / `50.0 × 50.0 mm` calibration squares, and `Cut On Fold` (`0` fold-edge SA) + hem allowance presets. Canonical `mm` internal geometry (`<= 0.1 mm` accuracy) with live `in` / `cm` / `mm` display switching.

---

## Quickstart

Install dependencies (`three`) and start the studio server (requires Node.js `>=24.0.0`):

```bash
npm install
npm start
```

Open `http://127.0.0.1:4174` in your browser.

Custom host or port:

```bash
node src/server.mjs --host=0.0.0.0 --port=4174
# or via environment variables:
HOST=0.0.0.0 PORT=4174 node src/server.mjs
```

If running on a remote machine over SSH:

```bash
ssh -L 4174:localhost:4174 <your-remote-host>
```

---

## Project Layout

```text
sewcad/
├── LICENSE                   # MIT License
├── package.json              # Node.js >=24 ESM config & npm scripts
├── README.md                 # Documentation
├── src/
│   ├── server.mjs            # HTTP server (static UI, /vendor/three/*, /src/core/*, REST API)
│   ├── cli.mjs               # CLI (list, template, unwrap, verify-sim)
│   └── core/                 # Isomorphic pure ESM core shared by Node & Browser
│       ├── index.mjs         # Unified barrel exports
│       ├── types.mjs         # Canonical PatternProject schema, ValidationError, unit conversion
│       ├── geometry.mjs      # 2D/3D math, Beziers, outward SA, darts, notches, triangulation
│       ├── womens_templates.mjs # 6 women's slopers/garment blocks & XS–2X size presets
│       ├── templates.mjs     # Template registry (11 blocks) + 2D CAD operations
│       ├── stl.mjs           # Binary & ASCII STL parser, topology, developable unwrapping
│       ├── materials.mjs     # 13 PBR presets (muslin, sateen, silk, linen, wool crepe, denim, leather, EVA)
│       ├── physics.mjs       # Sub-stepped XPBD cloth/sewing/dart solver, dress form & BVH STL colliders
│       ├── nesting.mjs       # Fabric roll & cutting-mat nesting (45", 54", 60", 36"x24" mat, A0, custom)
│       └── exporters.mjs     # True-scale 1:1 SVG, multi-page tiled PDF 1.4, CAD DXF ($INSUNITS=4), JSON
├── public/                   # Browser 2D CAD & Three.js PBR 3D Studio frontend
│   ├── index.html
│   ├── styles.css
│   ├── cad2d.mjs
│   ├── webgl3d.mjs
│   └── app.mjs
├── test/                     # Node unit & integration tests
└── e2e_tests/                # End-to-end verification suite
```

---

## CLI Usage (`src/cli.mjs`)

```bash
# Show usage
node src/cli.mjs --help

# List starter blocks, fabric presets, roll widths, and page formats
node src/cli.mjs list

# Generate a women's block and export 1:1 SVG, tiled PDF, DXF, and JSON
node src/cli.mjs template --type bodice_sloper --out ./out_bodice --format svg,pdf,dxf,json --page LETTER

# Unwrap a 3D .stl mesh into sewable cover pattern pieces
node src/cli.mjs unwrap \
  --stl ./path/to/part.stl \
  --mode form_shell_cover \
  --ease 4 \
  --sa 10 \
  --material eva_foam_4mm \
  --out ./out_cover \
  --format svg,pdf,dxf,json \
  --page A4

# Verify 3D XPBD cloth simulation stability
node src/cli.mjs verify-sim --template fit_flare_dress --material silk_charmeuse --steps 60
```

---

## Running Tests

```bash
npm test
```
