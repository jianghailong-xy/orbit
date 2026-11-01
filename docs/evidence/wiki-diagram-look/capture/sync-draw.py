# Copies the drawing lines of WikiDiagram.swift (between its two marks) into WikiDiagram.kt's DRAW, so the two stay one text.
import sys
root = sys.argv[1]
swift = open(f'{root}/src/macos/OrbitApp/Sources/OrbitApp/Views/WikiDiagram.swift').read()
kt_path = f'{root}/src/android/app/src/main/kotlin/io/orbitd/android/wiki/WikiDiagram.kt'
kt = open(kt_path).read()
start, end = '        // wiki diagram drawing: from here', '        // wiki diagram drawing: to here'
block = swift[swift.index(start):swift.index(end) + len(end)]
assert '$' not in block and '"""' not in block
k0, k1 = kt.index(start), kt.index(end) + len(end)
kt = kt[:k0] + block + kt[k1:]
open(kt_path, 'w').write(kt)
print('synced', block.count('\n') + 1, 'lines')
