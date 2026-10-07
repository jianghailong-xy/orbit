# Bytes and files the staged change removes/adds under docs/evidence/base-ui-migration/ (HEAD vs index),
# as `git ls-tree -r -l` sizes. Prints one JSON line.
import json, subprocess

P = 'docs/evidence/base-ui-migration/'


def tree_sizes(ref):
    out = subprocess.run(['git', 'ls-tree', '-r', '-l', ref, '--', P], capture_output=True, text=True, check=True).stdout
    sizes = {}
    for line in out.splitlines():
        meta, path = line.split('\t', 1)
        sizes[path] = int(meta.split()[3])
    return sizes


def index_sizes():
    # write the index as a tree object, then size it like any commit's tree
    tree = subprocess.run(['git', 'write-tree'], capture_output=True, text=True, check=True).stdout.strip()
    return tree_sizes(tree)


head, index = tree_sizes('HEAD'), index_sizes()
removed = [p for p in head if p not in index]
added = [p for p in index if p not in head]
changed = [p for p in index if p in head and index[p] != head[p]]
print(json.dumps({
    'removedFiles': len(removed), 'removedBytes': sum(head[p] for p in removed),
    'addedFiles': len(added), 'addedBytes': sum(index[p] for p in added),
    'changedFiles': len(changed), 'changedDelta': sum(index[p] - head[p] for p in changed),
    'beforeBytes': sum(head.values()), 'beforeFiles': len(head),
    'afterBytes': sum(index.values()), 'afterFiles': len(index),
}))
