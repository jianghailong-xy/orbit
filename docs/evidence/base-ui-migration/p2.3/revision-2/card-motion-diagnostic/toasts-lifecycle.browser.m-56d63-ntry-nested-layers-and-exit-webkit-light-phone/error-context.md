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
+ Received  + 2114

- Array []
+ Array [
+   Object {
+     "card": Object {
+       "bottom": 188,
+       "height": 144,
+       "left": 16,
+       "right": 366,
+       "top": 44,
+       "width": 350,
+       "x": 16,
+       "y": 44,
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
+     "t": 1073,
+   },
+   Object {
+     "card": Object {
+       "bottom": 195.89947128295898,
+       "height": 144,
+       "left": 16,
+       "right": 366,
+       "top": 51.899471282958984,
+       "width": 350,
+       "x": 16,
+       "y": 51.899471282958984,
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
+     "t": 1106,
+   },
+   Object {
+     "card": Object {
+       "bottom": 199.6010971069336,
+       "height": 144,
+       "left": 16,
+       "right": 366,
+       "top": 55.601097106933594,
+       "width": 350,
+       "x": 16,
+       "y": 55.601097106933594,
+     },
+     "opacity": "0.966758",
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
+         "translate": "61.373932%",
+       },
+     ],
+     "phase": "open",
+     "sameNode": true,
+     "t": 1176,
+   },
+   Object {
+     "card": Object {
+       "bottom": 199.86291885375977,
+       "height": 144,
+       "left": 16,
+       "right": 366,
+       "top": 55.862918853759766,
+       "width": 350,
+       "x": 16,
+       "y": 55.862918853759766,
+     },
+     "opacity": "0.988577",
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
+         "translate": "43.614746%",
+       },
+     ],
+     "phase": "open",
+     "sameNode": true,
+     "t": 1202,
+   },
+   Object {
+     "card": Object {
+       "bottom": 199.93624114990234,
+       "height": 144,
+       "left": 16,
+       "right": 366,
+       "top": 55.936241149902344,
+       "width": 350,
+       "x": 16,
+       "y": 55.936241149902344,
+     },
+     "opacity": "0.994687",
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
+         "translate": "35.727547%",
+       },
+     ],
+     "phase": "open",
+     "sameNode": true,
+     "t": 1216,
+   },
+   Object {
+     "card": Object {
+       "bottom": 199.97845458984375,
+       "height": 144,
+       "left": 16,
+       "right": 366,
+       "top": 55.97845458984375,
+       "width": 350,
+       "x": 16,
+       "y": 55.97845458984375,
+     },
+     "opacity": "0.998204",
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
+         "translate": "28.993528%",
+       },
+     ],
+     "phase": "open",
+     "sameNode": true,
+     "t": 1230,
+   },
+   Object {
+     "card": Object {
+       "bottom": 199.9985580444336,
+       "height": 144,
+       "left": 16,
+       "right": 366,
+       "top": 55.998558044433594,
+       "width": 350,
+       "x": 16,
+       "y": 55.998558044433594,
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
+         "translate": "22.54504%",
+       },
+     ],
+     "phase": "open",
+     "sameNode": true,
+     "t": 1246,
+   },
+   Object {
+     "card": Object {
+       "bottom": 188,
+       "height": 144,
+       "left": 16,
+       "right": 374,
+       "top": 44,
+       "width": 358,
+       "x": 16,
+       "y": 44,
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
+     "t": 1462,
+   },
+   Object {
+     "card": Object {
+       "bottom": 194.12418365478516,
+       "height": 144,
+       "left": 16,
+       "right": 374,
+       "top": 50.124183654785156,
+       "width": 358,
+       "x": 16,
+       "y": 50.124183654785156,
+     },
+     "opacity": "0.510349",
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
+     "t": 1485,
+   },
+   Object {
+     "card": Object {
+       "bottom": 199.2116813659668,
+       "height": 144,
+       "left": 16,
+       "right": 374,
+       "top": 55.2116813659668,
+       "width": 358,
+       "x": 16,
+       "y": 55.2116813659668,
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
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": false,
+         "opacity": "0.532733",
+         "scale": "0.953273",
+         "translate": "none",
+       },
+     ],
+     "phase": "nested-1",
+     "sameNode": true,
+     "t": 1545,
+   },
+   Object {
+     "card": Object {
+       "bottom": 199.7762336730957,
+       "height": 144,
+       "left": 16,
+       "right": 374,
+       "top": 55.7762336730957,
+       "width": 358,
+       "x": 16,
+       "y": 55.7762336730957,
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
+         "ending": false,
+         "opacity": "0.787071",
+         "scale": "0.978707",
+         "translate": "none",
+       },
+     ],
+     "phase": "nested-1",
+     "sameNode": true,
+     "t": 1580,
+   },
+   Object {
+     "card": Object {
+       "bottom": 199.91888427734375,
+       "height": 144,
+       "left": 16,
+       "right": 374,
+       "top": 55.91888427734375,
+       "width": 358,
+       "x": 16,
+       "y": 55.91888427734375,
+     },
+     "opacity": "0.99324",
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
+         "opacity": "0.874743",
+         "scale": "0.987474",
+         "translate": "none",
+       },
+     ],
+     "phase": "nested-1",
+     "sameNode": true,
+     "t": 1601,
+   },
+   Object {
+     "card": Object {
+       "bottom": 199.93214416503906,
+       "height": 144,
+       "left": 16,
+       "right": 374,
+       "top": 55.93214416503906,
+       "width": 358,
+       "x": 16,
+       "y": 55.93214416503906,
+     },
+     "opacity": "0.994345",
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
+     "t": 1604,
+   },
+   Object {
+     "card": Object {
+       "bottom": 199.9824333190918,
+       "height": 144,
+       "left": 16,
+       "right": 374,
+       "top": 55.9824333190918,
+       "width": 358,
+       "x": 16,
+       "y": 55.9824333190918,
+     },
+     "opacity": "0.998536",
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
+         "opacity": "0.933886",
+         "scale": "0.993389",
+         "translate": "none",
+       },
+     ],
+     "phase": "nested-1",
+     "sameNode": true,
+     "t": 1621,
+   },
+   Object {
+     "card": Object {
+       "bottom": 199.9980239868164,
+       "height": 144,
+       "left": 16,
+       "right": 374,
+       "top": 55.998023986816406,
+       "width": 358,
+       "x": 16,
+       "y": 55.998023986816406,
+     },
+     "opacity": "0.999835",
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
+         "opacity": "0.960459",
+         "scale": "0.996046",
+         "translate": "none",
+       },
+     ],
+     "phase": "nested-1",
+     "sameNode": true,
+     "t": 1634,
+   },
+   Object {
+     "card": Object {
+       "bottom": 200,
+       "height": 144,
+       "left": 16,
+       "right": 374,
+       "top": 56,
+       "width": 358,
+       "x": 16,
+       "y": 56,
+     },
+     "opacity": "1",
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
+         "opacity": "0.983822",
+         "scale": "0.998382",
+         "translate": "none",
+       },
+     ],
+     "phase": "nested-1",
+     "sameNode": true,
+     "t": 1651,
+   },
+   Object {
+     "card": Object {
+       "bottom": 200,
+       "height": 144,
+       "left": 16,
+       "right": 374,
+       "top": 56,
+       "width": 358,
+       "x": 16,
+       "y": 56,
+     },
+     "opacity": "1",
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
+     ],
+     "phase": "nested-1",
+     "sameNode": true,
+     "t": 1687,
+   },
+   Object {
+     "card": Object {
+       "bottom": 200,
+       "height": 144,
+       "left": 16,
+       "right": 374,
+       "top": 56,
+       "width": 358,
+       "x": 16,
+       "y": 56,
+     },
+     "opacity": "1",
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
+     ],
+     "phase": "nested-1",
+     "sameNode": true,
+     "t": 1731,
+   },
+   Object {
+     "card": Object {
+       "bottom": 200,
+       "height": 144,
+       "left": 16,
+       "right": 374,
+       "top": 56,
+       "width": 358,
+       "x": 16,
+       "y": 56,
+     },
+     "opacity": "1",
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
+     ],
+     "phase": "nested-1",
+     "sameNode": true,
+     "t": 1737,
+   },
+   Object {
+     "card": Object {
+       "bottom": 200,
+       "height": 144,
+       "left": 16,
+       "right": 374,
+       "top": 56,
+       "width": 358,
+       "x": 16,
+       "y": 56,
+     },
+     "opacity": "1",
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
+     ],
+     "phase": "nested-1",
+     "sameNode": true,
+     "t": 1750,
+   },
+   Object {
+     "card": Object {
+       "bottom": 200,
+       "height": 144,
+       "left": 16,
+       "right": 374,
+       "top": 56,
+       "width": 358,
+       "x": 16,
+       "y": 56,
+     },
+     "opacity": "1",
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
+     ],
+     "phase": "nested-1",
+     "sameNode": true,
+     "t": 1766,
+   },
+   Object {
+     "card": Object {
+       "bottom": 200,
+       "height": 144,
+       "left": 16,
+       "right": 374,
+       "top": 56,
+       "width": 358,
+       "x": 16,
+       "y": 56,
+     },
+     "opacity": "1",
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
+     ],
+     "phase": "nested-2",
+     "sameNode": true,
+     "t": 1782,
+   },
+   Object {
+     "card": Object {
+       "bottom": 200,
+       "height": 144,
+       "left": 16,
+       "right": 374,
+       "top": 56,
+       "width": 358,
+       "x": 16,
+       "y": 56,
+     },
+     "opacity": "1",
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
+     ],
+     "phase": "nested-2",
+     "sameNode": true,
+     "t": 1798,
+   },
+   Object {
+     "card": Object {
+       "bottom": 200,
+       "height": 144,
+       "left": 16,
+       "right": 374,
+       "top": 56,
+       "width": 358,
+       "x": 16,
+       "y": 56,
+     },
+     "opacity": "1",
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
+     ],
+     "phase": "nested-2",
+     "sameNode": true,
+     "t": 1799,
+   },
+   Object {
+     "card": Object {
+       "bottom": 200,
+       "height": 144,
+       "left": 16,
+       "right": 374,
+       "top": 56,
+       "width": 358,
+       "x": 16,
+       "y": 56,
+     },
+     "opacity": "1",
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
+     ],
+     "phase": "nested-2",
+     "sameNode": true,
+     "t": 1803,
+   },
+   Object {
+     "card": Object {
+       "bottom": 200,
+       "height": 144,
+       "left": 16,
+       "right": 374,
+       "top": 56,
+       "width": 358,
+       "x": 16,
+       "y": 56,
+     },
+     "opacity": "1",
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
+     ],
+     "phase": "nested-2",
+     "sameNode": true,
+     "t": 1818,
+   },
+   Object {
+     "card": Object {
+       "bottom": 197.39025115966797,
+       "height": 144,
+       "left": 16,
+       "right": 374,
+       "top": 53.39025115966797,
+       "width": 358,
+       "x": 16,
+       "y": 53.39025115966797,
+     },
+     "opacity": "0.782521",
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
+     "t": 1863,
+   },
+   Object {
+     "card": Object {
+       "bottom": 199.94396209716797,
+       "height": 144,
+       "left": 16,
+       "right": 374,
+       "top": 55.94396209716797,
+       "width": 358,
+       "x": 16,
+       "y": 55.94396209716797,
+     },
+     "opacity": "0.99533",
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
+     "t": 1962,
+   },
+   Object {
+     "card": Object {
+       "bottom": 200,
+       "height": 144,
+       "left": 16,
+       "right": 374,
+       "top": 56,
+       "width": 358,
+       "x": 16,
+       "y": 56,
+     },
+     "opacity": "1",
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
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+     ],
+     "phase": "nested-2",
+     "sameNode": true,
+     "t": 2201,
+   },
+   Object {
+     "card": Object {
+       "bottom": 191.2285041809082,
+       "height": 144,
+       "left": 16,
+       "right": 374,
+       "top": 47.2285041809082,
+       "width": 358,
+       "x": 16,
+       "y": 47.2285041809082,
+     },
+     "opacity": "0.269042",
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
+         "opacity": "1",
+         "scale": "1",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-2",
+     "sameNode": true,
+     "t": 2257,
+   },
+   Object {
+     "card": Object {
+       "bottom": 199.18561172485352,
+       "height": 144,
+       "left": 16,
+       "right": 374,
+       "top": 55.185611724853516,
+       "width": 358,
+       "x": 16,
+       "y": 55.185611724853516,
+     },
+     "opacity": "0.932134",
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
+         "opacity": "0.370483",
+         "scale": "0.937048",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-2",
+     "sameNode": true,
+     "t": 2328,
+   },
+   Object {
+     "card": Object {
+       "bottom": 199.81932067871094,
+       "height": 144,
+       "left": 16,
+       "right": 374,
+       "top": 55.81932067871094,
+       "width": 358,
+       "x": 16,
+       "y": 55.81932067871094,
+     },
+     "opacity": "0.985598",
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
+         "opacity": "0.136379",
+         "scale": "0.913638",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-2",
+     "sameNode": true,
+     "t": 2370,
+   },
+   Object {
+     "card": Object {
+       "bottom": 199.91412353515625,
+       "height": 144,
+       "left": 16,
+       "right": 374,
+       "top": 55.91412353515625,
+       "width": 358,
+       "x": 16,
+       "y": 55.91412353515625,
+     },
+     "opacity": "0.992844",
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
+         "opacity": "0.086859",
+         "scale": "0.908971",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-2",
+     "sameNode": true,
+     "t": 2384,
+   },
+   Object {
+     "card": Object {
+       "bottom": 199.9715919494629,
+       "height": 144,
+       "left": 16,
+       "right": 374,
+       "top": 55.97159194946289,
+       "width": 358,
+       "x": 16,
+       "y": 55.97159194946289,
+     },
+     "opacity": "0.997833",
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
+         "opacity": "0.048787",
+         "scale": "0.904879",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-2",
+     "sameNode": true,
+     "t": 2400,
+   },
+   Object {
+     "card": Object {
+       "bottom": 199.9985580444336,
+       "height": 144,
+       "left": 16,
+       "right": 374,
+       "top": 55.998558044433594,
+       "width": 358,
+       "x": 16,
+       "y": 55.998558044433594,
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
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": true,
+         "opacity": "0.02063",
+         "scale": "0.902063",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-2",
+     "sameNode": true,
+     "t": 2419,
+   },
+   Object {
+     "card": Object {
+       "bottom": 200,
+       "height": 144,
+       "left": 16,
+       "right": 374,
+       "top": 56,
+       "width": 358,
+       "x": 16,
+       "y": 56,
+     },
+     "opacity": "1",
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
+         "opacity": "0.006287",
+         "scale": "0.900629",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-2",
+     "sameNode": true,
+     "t": 2435,
+   },
+   Object {
+     "card": Object {
+       "bottom": 200,
+       "height": 144,
+       "left": 16,
+       "right": 374,
+       "top": 56,
+       "width": 358,
+       "x": 16,
+       "y": 56,
+     },
+     "opacity": "1",
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
+         "opacity": "0.000339",
+         "scale": "0.900034",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-2",
+     "sameNode": true,
+     "t": 2451,
+   },
+   Object {
+     "card": Object {
+       "bottom": 200,
+       "height": 144,
+       "left": 16,
+       "right": 374,
+       "top": 56,
+       "width": 358,
+       "x": 16,
+       "y": 56,
+     },
+     "opacity": "1",
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
+     ],
+     "phase": "close-2",
+     "sameNode": true,
+     "t": 2473,
+   },
+   Object {
+     "card": Object {
+       "bottom": 191.2285041809082,
+       "height": 144,
+       "left": 16,
+       "right": 374,
+       "top": 47.2285041809082,
+       "width": 358,
+       "x": 16,
+       "y": 47.2285041809082,
+     },
+     "opacity": "0.269042",
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
+     "t": 2518,
+   },
+   Object {
+     "card": Object {
+       "bottom": 197.47654342651367,
+       "height": 144,
+       "left": 16,
+       "right": 374,
+       "top": 53.47654342651367,
+       "width": 358,
+       "x": 16,
+       "y": 53.47654342651367,
+     },
+     "opacity": "0.789712",
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
+         "opacity": "0.738776",
+         "scale": "0.973878",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-1",
+     "sameNode": true,
+     "t": 2554,
+   },
+   Object {
+     "card": Object {
+       "bottom": 199.35295486450195,
+       "height": 144,
+       "left": 16,
+       "right": 374,
+       "top": 55.35295486450195,
+       "width": 358,
+       "x": 16,
+       "y": 55.35295486450195,
+     },
+     "opacity": "0.946079",
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
+         "opacity": "0.324648",
+         "scale": "0.932465",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-1",
+     "sameNode": true,
+     "t": 2596,
+   },
+   Object {
+     "card": Object {
+       "bottom": 199.6923713684082,
+       "height": 144,
+       "left": 16,
+       "right": 374,
+       "top": 55.6923713684082,
+       "width": 358,
+       "x": 16,
+       "y": 55.6923713684082,
+     },
+     "opacity": "0.974364",
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
+         "opacity": "0.197597",
+         "scale": "0.91976",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-1",
+     "sameNode": true,
+     "t": 2617,
+   },
+   Object {
+     "card": Object {
+       "bottom": 199.81932067871094,
+       "height": 144,
+       "left": 16,
+       "right": 374,
+       "top": 55.81932067871094,
+       "width": 358,
+       "x": 16,
+       "y": 55.81932067871094,
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
+         "translate": "none",
+       },
+       Object {
+         "ending": true,
+         "opacity": "0.140233",
+         "scale": "0.914023",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-1",
+     "sameNode": true,
+     "t": 2630,
+   },
+   Object {
+     "card": Object {
+       "bottom": 199.91888427734375,
+       "height": 144,
+       "left": 16,
+       "right": 374,
+       "top": 55.91888427734375,
+       "width": 358,
+       "x": 16,
+       "y": 55.91888427734375,
+     },
+     "opacity": "0.99324",
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
+         "opacity": "0.086859",
+         "scale": "0.908686",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-1",
+     "sameNode": true,
+     "t": 2646,
+   },
+   Object {
+     "card": Object {
+       "bottom": 199.9904441833496,
+       "height": 144,
+       "left": 16,
+       "right": 374,
+       "top": 55.99044418334961,
+       "width": 358,
+       "x": 16,
+       "y": 55.99044418334961,
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
+         "ending": false,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "none",
+       },
+       Object {
+         "ending": true,
+         "opacity": "0.032961",
+         "scale": "0.903296",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-1",
+     "sameNode": true,
+     "t": 2671,
+   },
+   Object {
+     "card": Object {
+       "bottom": 199.99900436401367,
+       "height": 144,
+       "left": 16,
+       "right": 374,
+       "top": 55.99900436401367,
+       "width": 358,
+       "x": 16,
+       "y": 55.99900436401367,
+     },
+     "opacity": "0.999917",
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
+         "opacity": "0.01946",
+         "scale": "0.901946",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-1",
+     "sameNode": true,
+     "t": 2681,
+   },
+   Object {
+     "card": Object {
+       "bottom": 200,
+       "height": 144,
+       "left": 16,
+       "right": 374,
+       "top": 56,
+       "width": 358,
+       "x": 16,
+       "y": 56,
+     },
+     "opacity": "1",
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
+         "opacity": "0.007592",
+         "scale": "0.900759",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-1",
+     "sameNode": true,
+     "t": 2694,
+   },
+   Object {
+     "card": Object {
+       "bottom": 200,
+       "height": 144,
+       "left": 16,
+       "right": 374,
+       "top": 56,
+       "width": 358,
+       "x": 16,
+       "y": 56,
+     },
+     "opacity": "1",
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
+         "opacity": "0.000668",
+         "scale": "0.900067",
+         "translate": "none",
+       },
+     ],
+     "phase": "close-1",
+     "sameNode": true,
+     "t": 2710,
+   },
+   Object {
+     "card": Object {
+       "bottom": 200,
+       "height": 144,
+       "left": 16,
+       "right": 374,
+       "top": 56,
+       "width": 358,
+       "x": 16,
+       "y": 56,
+     },
+     "opacity": "1",
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
+     ],
+     "phase": "close-1",
+     "sameNode": true,
+     "t": 2729,
+   },
+   Object {
+     "card": Object {
+       "bottom": 188,
+       "height": 144,
+       "left": 16,
+       "right": 374,
+       "top": 44,
+       "width": 358,
+       "x": 16,
+       "y": 44,
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
+         "ending": true,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "0%",
+       },
+     ],
+     "phase": "close-0",
+     "sameNode": true,
+     "t": 2749,
+   },
+   Object {
+     "card": Object {
+       "bottom": 195.59449768066406,
+       "height": 144,
+       "left": 16,
+       "right": 374,
+       "top": 51.59449768066406,
+       "width": 358,
+       "x": 16,
+       "y": 51.59449768066406,
+     },
+     "opacity": "0.632875",
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
+         "translate": "10.532383%",
+       },
+     ],
+     "phase": "close-0",
+     "sameNode": true,
+     "t": 2781,
+   },
+   Object {
+     "card": Object {
+       "bottom": 197.99813842773438,
+       "height": 144,
+       "left": 16,
+       "right": 374,
+       "top": 53.998138427734375,
+       "width": 358,
+       "x": 16,
+       "y": 53.998138427734375,
+     },
+     "opacity": "0.833178",
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
+         "translate": "25.748034%",
+       },
+     ],
+     "phase": "close-0",
+     "sameNode": true,
+     "t": 2804,
+   },
+   Object {
+     "card": Object {
+       "bottom": 198.12435150146484,
+       "height": 144,
+       "left": 16,
+       "right": 374,
+       "top": 54.124351501464844,
+       "width": 358,
+       "x": 16,
+       "y": 54.124351501464844,
+     },
+     "opacity": "0.843696",
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
+         "translate": "27.250641%",
+       },
+     ],
+     "phase": "close-0",
+     "sameNode": true,
+     "t": 2806,
+   },
+   Object {
+     "card": Object {
+       "bottom": 198.87680435180664,
+       "height": 144,
+       "left": 16,
+       "right": 374,
+       "top": 54.87680435180664,
+       "width": 358,
+       "x": 16,
+       "y": 54.87680435180664,
+     },
+     "opacity": "0.9064",
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
+         "translate": "39.371357%",
+       },
+     ],
+     "phase": "close-0",
+     "sameNode": true,
+     "t": 2822,
+   },
+   Object {
+     "card": Object {
+       "bottom": 199.33109664916992,
+       "height": 144,
+       "left": 16,
+       "right": 374,
+       "top": 55.33109664916992,
+       "width": 358,
+       "x": 16,
+       "y": 55.33109664916992,
+     },
+     "opacity": "0.944258",
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
+         "translate": "50.672047%",
+       },
+     ],
+     "phase": "close-0",
+     "sameNode": true,
+     "t": 2838,
+   },
+   Object {
+     "card": Object {
+       "bottom": 199.61529159545898,
+       "height": 144,
+       "left": 16,
+       "right": 374,
+       "top": 55.615291595458984,
+       "width": 358,
+       "x": 16,
+       "y": 55.615291595458984,
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
+         "ending": true,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "60.479469%",
+       },
+     ],
+     "phase": "close-0",
+     "sameNode": true,
+     "t": 2854,
+   },
+   Object {
+     "card": Object {
+       "bottom": 199.79425811767578,
+       "height": 144,
+       "left": 16,
+       "right": 374,
+       "top": 55.79425811767578,
+       "width": 358,
+       "x": 16,
+       "y": 55.79425811767578,
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
+         "ending": true,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "68.726334%",
+       },
+     ],
+     "phase": "close-0",
+     "sameNode": true,
+     "t": 2870,
+   },
+   Object {
+     "card": Object {
+       "bottom": 199.90407943725586,
+       "height": 144,
+       "left": 16,
+       "right": 374,
+       "top": 55.90407943725586,
+       "width": 358,
+       "x": 16,
+       "y": 55.90407943725586,
+     },
+     "opacity": "0.992006",
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
+         "translate": "75.571251%",
+       },
+     ],
+     "phase": "close-0",
+     "sameNode": true,
+     "t": 2886,
+   },
+   Object {
+     "card": Object {
+       "bottom": 199.9663963317871,
+       "height": 144,
+       "left": 16,
+       "right": 374,
+       "top": 55.96639633178711,
+       "width": 358,
+       "x": 16,
+       "y": 55.96639633178711,
+     },
+     "opacity": "0.997422",
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
+         "translate": "81.533676%",
+       },
+     ],
+     "phase": "close-0",
+     "sameNode": true,
+     "t": 2903,
+   },
+   Object {
+     "card": Object {
+       "bottom": 199.99589157104492,
+       "height": 144,
+       "left": 16,
+       "right": 374,
+       "top": 55.99589157104492,
+       "width": 358,
+       "x": 16,
+       "y": 55.99589157104492,
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
+         "ending": true,
+         "opacity": "1",
+         "scale": "none",
+         "translate": "86.106018%",
+       },
+     ],
+     "phase": "close-0",
+     "sameNode": true,
+     "t": 2919,
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