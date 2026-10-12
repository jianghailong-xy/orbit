# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: toasts-lifecycle.browser.mjs >> notification card stays fixed through Drawer entry, nested layers and exit
- Location: src/web/ui-migration/toasts-lifecycle.browser.mjs:94:3

# Error details

```
Error: existing card DOM, opacity and geometry stay stable at every sampled frame

expect(received).toEqual(expected) // deep equality

- Expected  -    1
+ Received  + 1850

- Array []
+ Array [
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 912,
+       "right": 1272,
+       "top": 16,
+       "width": 360,
+       "x": 912,
+       "y": 16,
+     },
+     "opacity": "0",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "100%",
+       },
+     ],
+     "phase": "open",
+     "sameNode": true,
+     "t": 1179,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 901.4673461914062,
+       "right": 1261.46728515625,
+       "top": 16,
+       "width": 359.99993896484375,
+       "x": 901.4673461914062,
+       "y": 16,
+     },
+     "opacity": "0.658289",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "100%",
+       },
+     ],
+     "phase": "open",
+     "sameNode": true,
+     "t": 1212,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 896.2409057617188,
+       "right": 1256.240966796875,
+       "top": 16,
+       "width": 360.00006103515625,
+       "x": 896.2409057617188,
+       "y": 16,
+     },
+     "opacity": "0.984943",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "46.091858%",
+       },
+     ],
+     "phase": "open",
+     "sameNode": true,
+     "t": 1302,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 896.1349487304688,
+       "right": 1256.135009765625,
+       "top": 16,
+       "width": 360.00006103515625,
+       "x": 896.1349487304688,
+       "y": 16,
+     },
+     "opacity": "0.991565",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "39.520531%",
+       },
+     ],
+     "phase": "open",
+     "sameNode": true,
+     "t": 1314,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 896.0652465820312,
+       "right": 1256.065185546875,
+       "top": 16,
+       "width": 359.99993896484375,
+       "x": 896.0652465820312,
+       "y": 16,
+     },
+     "opacity": "0.995923",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "33.196209%",
+       },
+     ],
+     "phase": "open",
+     "sameNode": true,
+     "t": 1326,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 896.00439453125,
+       "right": 1256.00439453125,
+       "top": 16,
+       "width": 360,
+       "x": 896.00439453125,
+       "y": 16,
+     },
+     "opacity": "0.999724",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "22.912712%",
+       },
+     ],
+     "phase": "open",
+     "sameNode": true,
+     "t": 1349,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 896.0001831054688,
+       "right": 1256.000244140625,
+       "top": 16,
+       "width": 360.00006103515625,
+       "x": 896.0001831054688,
+       "y": 16,
+     },
+     "opacity": "0.999987",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "20.772362%",
+       },
+     ],
+     "phase": "open",
+     "sameNode": true,
+     "t": 1356,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 912,
+       "right": 1272,
+       "top": 16,
+       "width": 360,
+       "x": 912,
+       "y": 16,
+     },
+     "opacity": "0",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "0",
+         "scale": "0.9",
+         "translate": "none",
+       },
+     ],
+     "phase": "nested-1",
+     "sameNode": true,
+     "t": 1625,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 899.8526000976562,
+       "right": 1259.8525390625,
+       "top": 16,
+       "width": 359.99993896484375,
+       "x": 899.8526000976562,
+       "y": 16,
+     },
+     "opacity": "0.767284",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "0",
+         "scale": "0.9",
+         "translate": "none",
+       },
+     ],
+     "phase": "nested-1",
+     "sameNode": true,
+     "t": 1669,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 896.6132202148438,
+       "right": 1256.61328125,
+       "top": 16,
+       "width": 360.00006103515625,
+       "x": 896.6132202148438,
+       "y": 16,
+     },
+     "opacity": "0.962999",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "0.493351",
+         "scale": "0.949335",
+         "translate": "none",
+       },
+     ],
+     "phase": "nested-1",
+     "sameNode": true,
+     "t": 1726,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 896.1741333007812,
+       "right": 1256.174072265625,
+       "top": 16,
+       "width": 359.99993896484375,
+       "x": 896.1741333007812,
+       "y": 16,
+     },
+     "opacity": "0.989117",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "0.735705",
+         "scale": "0.973571",
+         "translate": "none",
+       },
+     ],
+     "phase": "nested-1",
+     "sameNode": true,
+     "t": 1756,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 896.12109375,
+       "right": 1256.12109375,
+       "top": 16,
+       "width": 360,
+       "x": 896.12109375,
+       "y": 16,
+     },
+     "opacity": "0.992433",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "0.776371",
+         "scale": "0.977637",
+         "translate": "none",
+       },
+     ],
+     "phase": "nested-1",
+     "sameNode": true,
+     "t": 1763,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 896.0166015625,
+       "right": 1256.0166015625,
+       "top": 16,
+       "width": 360,
+       "x": 896.0166015625,
+       "y": 16,
+     },
+     "opacity": "0.998964",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "0.885229",
+         "scale": "0.988523",
+         "translate": "none",
+       },
+     ],
+     "phase": "nested-1",
+     "sameNode": true,
+     "t": 1788,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 896.001953125,
+       "right": 1256.001953125,
+       "top": 16,
+       "width": 360,
+       "x": 896.001953125,
+       "y": 16,
+     },
+     "opacity": "0.99988",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "0.918668",
+         "scale": "0.991867",
+         "translate": "none",
+       },
+     ],
+     "phase": "nested-1",
+     "sameNode": true,
+     "t": 1799,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 902.78564453125,
+       "right": 1262.78564453125,
+       "top": 16,
+       "width": 360,
+       "x": 902.78564453125,
+       "y": 16,
+     },
+     "opacity": "0.575898",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "0",
+         "scale": "0.9",
+         "translate": "none",
+       },
+     ],
+     "phase": "nested-2",
+     "sameNode": true,
+     "t": 1984,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 897.9331665039062,
+       "right": 1257.93310546875,
+       "top": 16,
+       "width": 359.99993896484375,
+       "x": 897.9331665039062,
+       "y": 16,
+     },
+     "opacity": "0.879175",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "0",
+         "scale": "0.9",
+         "translate": "none",
+       },
+     ],
+     "phase": "nested-2",
+     "sameNode": true,
+     "t": 2021,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 896.512939453125,
+       "right": 1256.512939453125,
+       "top": 16,
+       "width": 360,
+       "x": 896.512939453125,
+       "y": 16,
+     },
+     "opacity": "0.967941",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "0.306667",
+         "scale": "0.930667",
+         "translate": "none",
+       },
+     ],
+     "phase": "nested-2",
+     "sameNode": true,
+     "t": 2061,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 896.2742919921875,
+       "right": 1256.2742919921875,
+       "top": 16,
+       "width": 360,
+       "x": 896.2742919921875,
+       "y": 16,
+     },
+     "opacity": "0.982855",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "0.483169",
+         "scale": "0.948317",
+         "translate": "none",
+       },
+     ],
+     "phase": "nested-2",
+     "sameNode": true,
+     "t": 2077,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 896.165771484375,
+       "right": 1256.165771484375,
+       "top": 16,
+       "width": 360,
+       "x": 896.165771484375,
+       "y": 16,
+     },
+     "opacity": "0.98964",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "0.587622",
+         "scale": "0.958762",
+         "translate": "none",
+       },
+     ],
+     "phase": "nested-2",
+     "sameNode": true,
+     "t": 2088,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 896.060791015625,
+       "right": 1256.060791015625,
+       "top": 16,
+       "width": 360,
+       "x": 896.060791015625,
+       "y": 16,
+     },
+     "opacity": "0.996202",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "0.716647",
+         "scale": "0.971665",
+         "translate": "none",
+       },
+     ],
+     "phase": "nested-2",
+     "sameNode": true,
+     "t": 2105,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 896.0166015625,
+       "right": 1256.0166015625,
+       "top": 16,
+       "width": 360,
+       "x": 896.0166015625,
+       "y": 16,
+     },
+     "opacity": "0.998964",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "0.802403",
+         "scale": "0.98024",
+         "translate": "none",
+       },
+     ],
+     "phase": "nested-2",
+     "sameNode": true,
+     "t": 2119,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 896.0000610351562,
+       "right": 1256,
+       "top": 16,
+       "width": 359.99993896484375,
+       "x": 896.0000610351562,
+       "y": 16,
+     },
+     "opacity": "0.999997",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "0.867401",
+         "scale": "0.98674",
+         "translate": "none",
+       },
+     ],
+     "phase": "nested-2",
+     "sameNode": true,
+     "t": 2135,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 909.4843139648438,
+       "right": 1269.484375,
+       "top": 16,
+       "width": 360.00006103515625,
+       "x": 909.4843139648438,
+       "y": 16,
+     },
+     "opacity": "0.157231",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": true,
+         "opacity": "0.979789",
+         "scale": "0.997979",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-2",
+     "sameNode": true,
+     "t": 2271,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 900.4229736328125,
+       "right": 1260.4229736328125,
+       "top": 16,
+       "width": 360,
+       "x": 900.4229736328125,
+       "y": 16,
+     },
+     "opacity": "0.723563",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": true,
+         "opacity": "0.704756",
+         "scale": "0.970476",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-2",
+     "sameNode": true,
+     "t": 2304,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 899.1471557617188,
+       "right": 1259.147216796875,
+       "top": 16,
+       "width": 360.00006103515625,
+       "x": 899.1471557617188,
+       "y": 16,
+     },
+     "opacity": "0.803302",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": true,
+         "opacity": "0.591489",
+         "scale": "0.959149",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-2",
+     "sameNode": true,
+     "t": 2314,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 897.8723754882812,
+       "right": 1257.872314453125,
+       "top": 16,
+       "width": 359.99993896484375,
+       "x": 897.8723754882812,
+       "y": 16,
+     },
+     "opacity": "0.882976",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": true,
+         "opacity": "0.430111",
+         "scale": "0.943011",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-2",
+     "sameNode": true,
+     "t": 2330,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 897.0510864257812,
+       "right": 1257.051025390625,
+       "top": 16,
+       "width": 359.99993896484375,
+       "x": 897.0510864257812,
+       "y": 16,
+     },
+     "opacity": "0.934307",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": true,
+         "opacity": "0.289935",
+         "scale": "0.928994",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-2",
+     "sameNode": true,
+     "t": 2348,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 896.592041015625,
+       "right": 1256.592041015625,
+       "top": 16,
+       "width": 360,
+       "x": 896.592041015625,
+       "y": 16,
+     },
+     "opacity": "0.962999",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": true,
+         "opacity": "0.192672",
+         "scale": "0.919267",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-2",
+     "sameNode": true,
+     "t": 2365,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 896.3238525390625,
+       "right": 1256.3238525390625,
+       "top": 16,
+       "width": 360,
+       "x": 896.3238525390625,
+       "y": 16,
+     },
+     "opacity": "0.979758",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": true,
+         "opacity": "0.125257",
+         "scale": "0.912526",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-2",
+     "sameNode": true,
+     "t": 2381,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 896.1576538085938,
+       "right": 1256.15771484375,
+       "top": 16,
+       "width": 360.00006103515625,
+       "x": 896.1576538085938,
+       "y": 16,
+     },
+     "opacity": "0.990146",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": true,
+         "opacity": "0.076037",
+         "scale": "0.907604",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-2",
+     "sameNode": true,
+     "t": 2397,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 896.0524291992188,
+       "right": 1256.052490234375,
+       "top": 16,
+       "width": 360.00006103515625,
+       "x": 896.0524291992188,
+       "y": 16,
+     },
+     "opacity": "0.996723",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": true,
+         "opacity": "0.03783",
+         "scale": "0.903783",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-2",
+     "sameNode": true,
+     "t": 2415,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 896.0094604492188,
+       "right": 1256.009521484375,
+       "top": 16,
+       "width": 360.00006103515625,
+       "x": 896.0094604492188,
+       "y": 16,
+     },
+     "opacity": "0.99941",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": true,
+         "opacity": "0.016178",
+         "scale": "0.901618",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-2",
+     "sameNode": true,
+     "t": 2431,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 909.8452758789062,
+       "right": 1269.84521484375,
+       "top": 16,
+       "width": 359.99993896484375,
+       "x": 909.8452758789062,
+       "y": 16,
+     },
+     "opacity": "0.134671",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": true,
+         "opacity": "1",
+         "scale": "1",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-1",
+     "sameNode": true,
+     "t": 2511,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 900.9141235351562,
+       "right": 1260.9140625,
+       "top": 16,
+       "width": 359.99993896484375,
+       "x": 900.9141235351562,
+       "y": 16,
+     },
+     "opacity": "0.692866",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": true,
+         "opacity": "0.793639",
+         "scale": "0.979364",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-1",
+     "sameNode": true,
+     "t": 2542,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 898.58349609375,
+       "right": 1258.58349609375,
+       "top": 16,
+       "width": 360,
+       "x": 898.58349609375,
+       "y": 16,
+     },
+     "opacity": "0.838531",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": true,
+         "opacity": "0.580497",
+         "scale": "0.95805",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-1",
+     "sameNode": true,
+     "t": 2561,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 897.6480102539062,
+       "right": 1257.64794921875,
+       "top": 16,
+       "width": 359.99993896484375,
+       "x": 897.6480102539062,
+       "y": 16,
+     },
+     "opacity": "0.896999",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": true,
+         "opacity": "0.439189",
+         "scale": "0.943919",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-1",
+     "sameNode": true,
+     "t": 2575,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 896.9845581054688,
+       "right": 1256.984619140625,
+       "top": 16,
+       "width": 360.00006103515625,
+       "x": 896.9845581054688,
+       "y": 16,
+     },
+     "opacity": "0.938463",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": true,
+         "opacity": "0.310396",
+         "scale": "0.93104",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-1",
+     "sameNode": true,
+     "t": 2591,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 896.5714111328125,
+       "right": 1256.5714111328125,
+       "top": 16,
+       "width": 360,
+       "x": 896.5714111328125,
+       "y": 16,
+     },
+     "opacity": "0.964288",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": true,
+         "opacity": "0.212929",
+         "scale": "0.921293",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-1",
+     "sameNode": true,
+     "t": 2607,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 896.29833984375,
+       "right": 1256.29833984375,
+       "top": 16,
+       "width": 360,
+       "x": 896.29833984375,
+       "y": 16,
+     },
+     "opacity": "0.981353",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": true,
+         "opacity": "0.136379",
+         "scale": "0.913638",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-1",
+     "sameNode": true,
+     "t": 2624,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 896.0797729492188,
+       "right": 1256.079833984375,
+       "top": 16,
+       "width": 360.00006103515625,
+       "x": 896.0797729492188,
+       "y": 16,
+     },
+     "opacity": "0.995015",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": true,
+         "opacity": "0.059235",
+         "scale": "0.905924",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-1",
+     "sameNode": true,
+     "t": 2650,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 896.0485229492188,
+       "right": 1256.048583984375,
+       "top": 16,
+       "width": 360.00006103515625,
+       "x": 896.0485229492188,
+       "y": 16,
+     },
+     "opacity": "0.996967",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": true,
+         "opacity": "0.044948",
+         "scale": "0.904495",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-1",
+     "sameNode": true,
+     "t": 2657,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 896.0054931640625,
+       "right": 1256.0054931640625,
+       "top": 16,
+       "width": 360,
+       "x": 896.0054931640625,
+       "y": 16,
+     },
+     "opacity": "0.999658",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": true,
+         "opacity": "0.018328",
+         "scale": "0.901833",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-1",
+     "sameNode": true,
+     "t": 2675,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 906.653076171875,
+       "right": 1266.653076171875,
+       "top": 16,
+       "width": 360,
+       "x": 906.653076171875,
+       "y": 16,
+     },
+     "opacity": "0.334182",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": true,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "3.295154%",
+       },
+     ],
+     "phase": "close-0",
+     "sameNode": true,
+     "t": 2762,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 898.58349609375,
+       "right": 1258.58349609375,
+       "top": 16,
+       "width": 360,
+       "x": 898.58349609375,
+       "y": 16,
+     },
+     "opacity": "0.838531",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": true,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "26.497677%",
+       },
+     ],
+     "phase": "close-0",
+     "sameNode": true,
+     "t": 2803,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 897.701416015625,
+       "right": 1257.701416015625,
+       "top": 16,
+       "width": 360,
+       "x": 897.701416015625,
+       "y": 16,
+     },
+     "opacity": "0.89366",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": true,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "36.371773%",
+       },
+     ],
+     "phase": "close-0",
+     "sameNode": true,
+     "t": 2816,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 897.017333984375,
+       "right": 1257.017333984375,
+       "top": 16,
+       "width": 360,
+       "x": 897.017333984375,
+       "y": 16,
+     },
+     "opacity": "0.936416",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": true,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "47.974613%",
+       },
+     ],
+     "phase": "close-0",
+     "sameNode": true,
+     "t": 2832,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 896.592041015625,
+       "right": 1256.592041015625,
+       "top": 16,
+       "width": 360,
+       "x": 896.592041015625,
+       "y": 16,
+     },
+     "opacity": "0.962999",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": true,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "58.17733%",
+       },
+     ],
+     "phase": "close-0",
+     "sameNode": true,
+     "t": 2848,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 896.3238525390625,
+       "right": 1256.3238525390625,
+       "top": 16,
+       "width": 360,
+       "x": 896.3238525390625,
+       "y": 16,
+     },
+     "opacity": "0.979758",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": true,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "66.803795%",
+       },
+     ],
+     "phase": "close-0",
+     "sameNode": true,
+     "t": 2864,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 896.1576538085938,
+       "right": 1256.15771484375,
+       "top": 16,
+       "width": 360.00006103515625,
+       "x": 896.1576538085938,
+       "y": 16,
+     },
+     "opacity": "0.990146",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": true,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "73.980324%",
+       },
+     ],
+     "phase": "close-0",
+     "sameNode": true,
+     "t": 2880,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 896.060791015625,
+       "right": 1256.060791015625,
+       "top": 16,
+       "width": 360,
+       "x": 896.060791015625,
+       "y": 16,
+     },
+     "opacity": "0.996202",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": true,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "79.906914%",
+       },
+     ],
+     "phase": "close-0",
+     "sameNode": true,
+     "t": 2896,
+   },
+   Object {
+     "card": Object {
+       "bottom": 144,
+       "height": 128,
+       "left": 896.0127563476562,
+       "right": 1256.0126953125,
+       "top": 16,
+       "width": 359.99993896484375,
+       "x": 896.0127563476562,
+       "y": 16,
+     },
+     "opacity": "0.999204",
+     "overlays": Array [
+       Object {
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": true,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "84.775192%",
+       },
+     ],
+     "phase": "close-0",
+     "sameNode": true,
+     "t": 2912,
+   },
+ ]
```

# Page snapshot

```yaml
- generic [ref=e1]:
  - main [ref=e4]:
    - heading "Notification integration" [level=1] [ref=e5]
    - status [ref=e6]: light
    - status "Location" [ref=e7]: /ui-migration/toasts.html
    - generic [ref=e8]:
      - button "Short notice" [ref=e9] [cursor=pointer]
      - button "Error notice" [ref=e11] [cursor=pointer]
      - button "Warning notice" [ref=e13] [cursor=pointer]
      - button "Complete session" [ref=e15] [cursor=pointer]
      - button "Session result" [ref=e17] [cursor=pointer]
      - button "Session failure" [ref=e19] [cursor=pointer]
      - button "Clear notifications" [ref=e21] [cursor=pointer]
      - button "Switch theme" [ref=e23] [cursor=pointer]
      - button "Nested dialog" [ref=e25] [cursor=pointer]
      - button "Confirm save" [ref=e27] [cursor=pointer]
    - status "Undo count" [ref=e29]: "0"
    - button "Open Dialog" [ref=e30] [cursor=pointer]
    - button "Open Drawer" [active] [ref=e32] [cursor=pointer]
    - button "Open Bottom drawer" [ref=e34] [cursor=pointer]
    - button "Open Retained dialog" [ref=e36] [cursor=pointer]
    - button "Legacy confirm" [ref=e38] [cursor=pointer]
  - generic [ref=e40]: Couldn't save the schedule. revision 12 is stale
  - generic:
    - region "Notifications":
      - generic [ref=e41]:
        - generic [ref=e42]:
          - generic [ref=e46]: Couldn't save the schedule
          - button "Dismiss" [ref=e48] [cursor=pointer]:
            - img "close" [ref=e49]
        - generic [ref=e52]: revision 12 is stale
        - button "Copy error" [ref=e54] [cursor=pointer]
```

# Test source

```ts
  36  |     });
  37  |     await button(page, `Open ${kind}`).click();
  38  |     await page.waitForFunction(() => window.motionDone);
  39  |     const samples = await page.evaluate(() => window.motionSamples);
  40  |     const shifted = samples.filter(s => Math.abs(s.x - before.x) > 1 || Math.abs(s.y - before.y) > 1);
  41  |     await info.attach('entry-geometry', { body: JSON.stringify({ kind, before, samples, shifted }, null, 2), contentType: 'application/json' });
  42  |     expect(shifted, 'an existing notification should not move with the newly opening modal').toHaveLength(0);
  43  |   });
  44  | }
  45  | 
  46  | test('hover pause releases after a keyboard opened and closed overlay changes portal', async ({ page }, info) => {
  47  |   await page.clock.install({ time: new Date('2026-10-04T00:00:00Z') });
  48  |   await page.clock.pauseAt(new Date('2026-10-04T00:00:01Z'));
  49  |   await button(page, 'Complete session').click();
  50  |   const region = page.locator('.toast-viewport');
  51  |   await region.locator('button[aria-label="Undo completing Fix login redirect"]').hover();
  52  |   await page.clock.runFor(10000);
  53  |   await expect(region).toBeVisible();
  54  |   await button(page, 'Open Dialog').focus();
  55  |   await page.keyboard.press('Enter');
  56  |   await page.clock.runFor(200);
  57  |   await expect(page.getByRole('dialog', { name: 'Workspace editor', exact: true })).toBeVisible();
  58  |   await page.keyboard.press('Escape');
  59  |   await page.clock.runFor(200);
  60  |   await expect(page.getByRole('dialog', { name: 'Workspace editor', exact: true })).not.toBeVisible();
  61  |   await page.mouse.move(0, 0);
  62  |   await page.clock.runFor(6001);
  63  |   const after = await region.count();
  64  |   await info.attach('timer-after-portal', { body: JSON.stringify({ after, releasedAfterMs: 6001 }), contentType: 'application/json' });
  65  |   expect(after).toBe(0);
  66  | });
  67  | 
  68  | 
  69  | test('native hover deadline resumes after portal changes', async ({ page }, info) => {
  70  |   await button(page, 'Complete session').click();
  71  |   const region = page.locator('.toast-viewport');
  72  |   await region.locator('button[aria-label="Undo completing Fix login redirect"]').hover();
  73  |   await button(page, 'Open Dialog').focus();
  74  |   await page.keyboard.press('Enter');
  75  |   await expect(page.getByRole('dialog', { name: 'Workspace editor', exact: true })).toBeVisible();
  76  |   await page.keyboard.press('Escape');
  77  |   await expect(page.getByRole('dialog', { name: 'Workspace editor', exact: true })).not.toBeVisible();
  78  |   await page.mouse.move(0, 0);
  79  |   const releasedAt = Date.now();
  80  |   try { await expect(region).toHaveCount(0, { timeout: 7500 }); }
  81  |   finally {
  82  |     await info.attach('native-timer', {body: JSON.stringify({ elapsedMs:Date.now()-releasedAt, count:await region.count() }), contentType:'application/json'});
  83  |   }
  84  | });
  85  | 
  86  | const region = (page) => page.getByRole('region', { name: 'Notifications', exact: true });
  87  | const attach = (info, name, value) => info.attach(name, { body: JSON.stringify(value, null, 2), contentType: 'application/json' });
  88  | const finishMotion = (page) => page.evaluate(async () => {
  89  |   await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  90  |   await Promise.all(document.getAnimations().filter((a) => a.effect?.getComputedTiming().iterations !== Infinity).map((a) => a.finished.catch(() => {})));
  91  | });
  92  | 
  93  | for (const kind of ['Dialog', 'Drawer', 'Bottom drawer']) {
  94  |   test(`notification card stays fixed through ${kind} entry, nested layers and exit`, async ({ page }, info) => {
  95  |     await page.emulateMedia({ reducedMotion: 'no-preference' });
  96  |     await button(page, 'Error notice').click();
  97  |     await page.mouse.move(0, 0);
  98  |     await finishMotion(page);
  99  |     await page.evaluate(() => {
  100 |       const card = document.querySelector('.toast');
  101 |       window.cardMotion = { before: card.getBoundingClientRect().toJSON(), samples: [], phase: 'before', running: true };
  102 |       const sample = () => {
  103 |         const current = document.querySelector('.toast');
  104 |         const r = current?.getBoundingClientRect();
  105 |         window.cardMotion.samples.push({ phase: window.cardMotion.phase, t: performance.now(), sameNode: current === card,
  106 |           card: r?.toJSON(), opacity: current ? getComputedStyle(current).opacity : null,
  107 |           overlays: [...document.querySelectorAll('.orbit-overlay')].map((el) => {
  108 |             const s = getComputedStyle(el);
  109 |             return { scale: s.scale, translate: s.translate, opacity: s.opacity, ending: el.hasAttribute('data-ending-style') };
  110 |           }) });
  111 |         if (window.cardMotion.running) requestAnimationFrame(sample);
  112 |       };
  113 |       requestAnimationFrame(sample);
  114 |     });
  115 |     const phase = (name) => page.evaluate((value) => { window.cardMotion.phase = value; }, name);
  116 |     await phase('open');
  117 |     await button(page, `Open ${kind}`).click();
  118 |     await finishMotion(page);
  119 |     for (let depth = 1; depth <= 2; depth++) {
  120 |       await phase(`nested-${depth}`);
  121 |       await button(page, 'Nested dialog').click();
  122 |       await finishMotion(page);
  123 |       await expect(region(page)).toBeVisible();
  124 |     }
  125 |     for (let depth = 2; depth >= 0; depth--) {
  126 |       await phase(`close-${depth}`);
  127 |       await page.keyboard.press('Escape');
  128 |       await finishMotion(page);
  129 |       await expect(region(page)).toBeVisible();
  130 |     }
  131 |     const motion = await page.evaluate(() => { window.cardMotion.running = false; return window.cardMotion; });
  132 |     await attach(info, 'continuous-card-motion', motion);
  133 |     expect(motion.samples.length).toBeGreaterThan(20);
  134 |     const shifted = motion.samples.filter((s) => !s.sameNode || !s.card || s.opacity !== '1' ||
  135 |       ['x', 'y', 'width', 'height'].some((key) => Math.abs(s.card[key] - motion.before[key]) > 0.1));
> 136 |     expect(shifted, 'existing card DOM, opacity and geometry stay stable at every sampled frame').toEqual([]);
      |                                                                                                   ^ Error: existing card DOM, opacity and geometry stay stable at every sampled frame
  137 |     // These checks also prove the original popup transitions still run in both directions.
  138 |     for (const name of ['open', 'nested-1', 'nested-2', 'close-2', 'close-1', 'close-0']) {
  139 |       expect(motion.samples.some((s) => s.phase === name && s.overlays.some((o) =>
  140 |         Number(o.opacity) < 1 || (o.translate !== 'none' && o.translate !== '0px') || (o.scale !== 'none' && o.scale !== '1'))), name).toBe(true);
  141 |     }
  142 |     await expect(button(page, `Open ${kind}`)).toBeFocused();
  143 |   });
  144 | }
  145 | 
  146 | test('stationary hover stays paused across nested modal owners then resumes for exactly six seconds', async ({ page }, info) => {
  147 |   await page.clock.install({ time: new Date('2026-10-04T00:00:00Z') });
  148 |   await page.clock.pauseAt(new Date('2026-10-04T00:00:01Z'));
  149 |   await button(page, 'Complete session').click();
  150 |   await region(page).getByRole('button', { name: 'Undo completing Fix login redirect', exact: true }).hover();
  151 |   await page.clock.runFor(10000);
  152 |   await expect(region(page)).toBeVisible();
  153 |   for (const name of ['Open Dialog', 'Nested dialog']) {
  154 |     await button(page, name).focus();
  155 |     await page.keyboard.press('Enter');
  156 |     await page.clock.runFor(10200);
  157 |     await expect(region(page)).toBeVisible();
  158 |   }
  159 |   for (let i = 0; i < 2; i++) {
  160 |     await page.keyboard.press('Escape');
  161 |     await page.clock.runFor(10200);
  162 |     await expect(region(page)).toBeVisible();
  163 |   }
  164 |   await page.mouse.move(0, 0);
  165 |   await page.clock.runFor(5999);
  166 |   await expect(region(page)).toBeVisible();
  167 |   await page.clock.runFor(1);
  168 |   await expect(region(page)).toHaveCount(0);
  169 |   await attach(info, 'stationary-hover', { pausedAcrossFourTransfersMs: 40800, pausedBeforeTransfersMs: 10000, visibleAfterReleaseMs: 5999, expiredAfterReleaseMs: 6000 });
  170 | });
  171 | 
  172 | test('unhovered notifications retain their original deadline through modal owner changes', async ({ page }, info) => {
  173 |   await page.clock.install({ time: new Date('2026-10-04T00:00:00Z') });
  174 |   await page.clock.pauseAt(new Date('2026-10-04T00:00:01Z'));
  175 |   await button(page, 'Complete session').click();
  176 |   await page.mouse.move(0, 0);
  177 |   await page.clock.runFor(2000);
  178 |   await button(page, 'Open Drawer').focus();
  179 |   await page.keyboard.press('Enter');
  180 |   await page.clock.runFor(200);
  181 |   await page.keyboard.press('Escape');
  182 |   await page.clock.runFor(3799);
  183 |   await expect(region(page)).toBeVisible();
  184 |   await page.clock.runFor(1);
  185 |   await expect(region(page)).toHaveCount(0);
  186 |   await attach(info, 'unchanged-deadline', { visibleAtTotalMs: 5999, expiredAtTotalMs: 6000 });
  187 | });
  188 | 
```