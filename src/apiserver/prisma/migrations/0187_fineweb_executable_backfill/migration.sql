-- N19: explicit, bounded operator migration for the FineWeb shard DAG.
--
-- Schema deployment installs only the classifier, audit ledger and one-batch operator doors. It
-- deliberately does not update Task. The operator first reviews n19_fineweb_executable_inventory,
-- calls n19_fineweb_executable_prepare once, and then calls
-- n19_fineweb_executable_backfill_step in separate transactions until finished=true. One call is
-- one committed batch. n19_fineweb_executable_rollback_step restores the exact prior declaration
-- in the same bounded shape and refuses any row whose status or installed declaration drifted.

CREATE TABLE "task_executable_backfill_batch" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "project_id" uuid NOT NULL,
  "idempotency_key" text NOT NULL,
  "command_version" text NOT NULL,
  "batch_size" integer NOT NULL,
  "status" text NOT NULL DEFAULT 'RUNNING',
  "upper_bound_task_id" uuid NOT NULL,
  "last_task_id" uuid,
  "source_task_count" bigint NOT NULL,
  "candidate_count" bigint NOT NULL,
  "unclassified_count" bigint NOT NULL,
  "class_counts" jsonb NOT NULL,
  "pre_status_counts" jsonb NOT NULL,
  "post_status_counts" jsonb,
  "batch_count" integer NOT NULL DEFAULT 0,
  "migrated_count" bigint NOT NULL DEFAULT 0,
  "rolled_back_count" bigint NOT NULL DEFAULT 0,
  "started_at" timestamptz NOT NULL DEFAULT clock_timestamp(),
  "finished_at" timestamptz,
  "rolled_back_at" timestamptz,

  CONSTRAINT "task_executable_backfill_batch_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "task_executable_backfill_batch_project_fkey"
    FOREIGN KEY ("project_id") REFERENCES "project"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "task_executable_backfill_batch_key_nonblank"
    CHECK (length(btrim("idempotency_key")) BETWEEN 1 AND 200),
  CONSTRAINT "task_executable_backfill_batch_version_nonblank"
    CHECK (length(btrim("command_version")) BETWEEN 1 AND 100),
  CONSTRAINT "task_executable_backfill_batch_size"
    CHECK ("batch_size" BETWEEN 1 AND 1000),
  CONSTRAINT "task_executable_backfill_batch_status"
    CHECK ("status" IN ('RUNNING', 'FINISHED', 'ROLLING_BACK', 'ROLLED_BACK')),
  CONSTRAINT "task_executable_backfill_batch_counts"
    CHECK (
      "source_task_count" >= 0
      AND "candidate_count" >= 0
      AND "unclassified_count" >= 0
      AND "candidate_count" + "unclassified_count" = "source_task_count"
      AND "batch_count" >= 0
      AND "migrated_count" >= 0
      AND "rolled_back_count" >= 0
      AND "rolled_back_count" <= "migrated_count"
    ),
  CONSTRAINT "task_executable_backfill_batch_project_key"
    UNIQUE ("project_id", "idempotency_key")
);

CREATE UNIQUE INDEX "task_executable_backfill_one_running_project"
  ON "task_executable_backfill_batch"("project_id")
  WHERE "status" = 'RUNNING';

CREATE TABLE "task_executable_backfill_item" (
  "batch_id" uuid NOT NULL,
  "task_id" uuid NOT NULL,
  "task_class" text NOT NULL,
  "previous_status" "task_status" NOT NULL,
  "previous_completion_criterion" "task_completion_criterion" NOT NULL,
  "previous_acceptance_command" text,
  "previous_expected_exit_code" integer,
  "installed_acceptance_command_sha256" text NOT NULL,
  "installed_expected_exit_code" integer NOT NULL,
  "migrated_at" timestamptz NOT NULL DEFAULT clock_timestamp(),
  "rolled_back_at" timestamptz,

  CONSTRAINT "task_executable_backfill_item_pkey" PRIMARY KEY ("batch_id", "task_id"),
  CONSTRAINT "task_executable_backfill_item_batch_fkey"
    FOREIGN KEY ("batch_id") REFERENCES "task_executable_backfill_batch"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "task_executable_backfill_item_task_fkey"
    FOREIGN KEY ("task_id") REFERENCES "task"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "task_executable_backfill_item_class"
    CHECK ("task_class" IN ('FINEWEB', 'WARC', 'MERGE', 'VERIFY')),
  CONSTRAINT "task_executable_backfill_item_command_digest"
    CHECK ("installed_acceptance_command_sha256" ~ '^[0-9a-f]{64}$')
);

CREATE INDEX "task_executable_backfill_item_rollback_idx"
  ON "task_executable_backfill_item"("batch_id", "task_id")
  WHERE "rolled_back_at" IS NULL;

-- Exactly one row is returned for every input Task. task_class/acceptance_command are non-NULL
-- only when both the title and the existing acceptance prose match the reviewed N19 template.
-- A recognized prefix with any prose drift is deliberately unclassified rather than guessed.
CREATE FUNCTION "n19_fineweb_executable_classify"(
  p_title text,
  p_description text,
  p_acceptance_criteria text
) RETURNS TABLE (
  task_class text,
  acceptance_command text,
  reason text
) LANGUAGE plpgsql IMMUTABLE AS $function$
DECLARE
  title_parts text[];
  expected_criteria text;
  expected_sizes text[];
  command_template text;
BEGIN
  title_parts := regexp_match(
    p_title,
    '^\[FineWeb\]\[(CC-MAIN-[0-9]{4}-[0-9]{2})\] ([0-9]{3}_[0-9]{5})\.parquet$'
  );
  IF title_parts IS NOT NULL THEN
    expected_criteria := format(
      '/data/tmp/fineweb/data/%s/%s.parquet 存在且字节数等于任务声明的预期大小，Parquet footer/schema 可读；/data/wikova/common-crawl/.fineweb-warc-tasks/manifests/%s__%s.json 存在、可解析、warcs[] 已按路径去重且每项带 size_bytes 与 etag。未下载任何 WARC 内容，未修改其他 Parquet。',
      title_parts[1], title_parts[2], title_parts[1], title_parts[2]
    );
    IF p_acceptance_criteria IS DISTINCT FROM expected_criteria THEN
      RETURN QUERY SELECT NULL::text, NULL::text,
        'FineWeb 验收文字与严格模板不一致；未猜测命令。'::text;
      RETURN;
    END IF;
    SELECT array_agg(match_row.capture[1]) INTO expected_sizes
      FROM regexp_matches(
        coalesce(p_description, ''),
        '预期大小：([0-9]+) bytes',
        'g'
      ) AS match_row(capture);
    IF coalesce(cardinality(expected_sizes), 0) <> 1 THEN
      RETURN QUERY SELECT NULL::text, NULL::text,
        'FineWeb 描述中没有且仅有一个“预期大小：N bytes”；未猜测大小。'::text;
      RETURN;
    END IF;

    command_template := $command$set -eu
python3 - '__DUMP__' '__SHARD__' '__EXPECTED__' <<'PY'
import json
import sys
from pathlib import Path
from pyarrow.parquet import ParquetFile

dump, shard, expected_text = sys.argv[1:]
expected = int(expected_text)
parquet = Path(f"/data/tmp/fineweb/data/{dump}/{shard}.parquet")
manifest = Path(f"/data/wikova/common-crawl/.fineweb-warc-tasks/manifests/{dump}__{shard}.json")
status = Path(f"/data/wikova/fineweb/.fineweb-file-tasks/status/{dump}__{shard}.json")
assert parquet.is_file(), f"missing Parquet: {parquet}"
actual = parquet.stat().st_size
assert actual == expected, f"Parquet size {actual} != {expected}"
pf = ParquetFile(parquet)
assert pf.metadata is not None and pf.schema_arrow is not None, "Parquet footer/schema unreadable"
doc = json.loads(manifest.read_text(encoding="utf-8"))
warcs = doc.get("warcs")
assert isinstance(warcs, list), "manifest warcs is not a list"
paths = []
for index, item in enumerate(warcs):
    assert isinstance(item, dict), f"warcs[{index}] is not an object"
    path = item.get("path")
    size = item.get("size_bytes")
    etag = item.get("etag")
    assert isinstance(path, str) and path, f"warcs[{index}].path missing"
    assert isinstance(size, int) and size >= 0, f"warcs[{index}].size_bytes invalid"
    assert isinstance(etag, str) and etag, f"warcs[{index}].etag missing"
    paths.append(path)
assert len(paths) == len(set(paths)), "manifest contains duplicate WARC paths"
state = json.loads(status.read_text(encoding="utf-8"))
assert isinstance(state, dict), "FineWeb status is not an object"
print(json.dumps({
    "stage": "FineWeb",
    "dump": dump,
    "shard": shard,
    "parquet_bytes": actual,
    "parquet_rows": pf.metadata.num_rows,
    "warc_count": len(warcs),
    "status_keys": sorted(state),
}, ensure_ascii=False, sort_keys=True))
PY$command$;
    command_template := replace(command_template, '__DUMP__', title_parts[1]);
    command_template := replace(command_template, '__SHARD__', title_parts[2]);
    command_template := replace(command_template, '__EXPECTED__', expected_sizes[1]);
    RETURN QUERY SELECT 'FINEWEB'::text, command_template, NULL::text;
    RETURN;
  END IF;

  title_parts := regexp_match(
    p_title,
    '^\[WARC\]\[(CC-MAIN-[0-9]{4}-[0-9]{2})\] ([0-9]{3}_[0-9]{5}) 的 WARC 依赖$'
  );
  IF title_parts IS NOT NULL THEN
    expected_criteria := format(
      'warc_inventory.py --dump %s --shard %s 报告状态为「齐全，可直接 merge」：清单内每个 WARC 都能在 warc_roots 之一找到且字节数等于 size_bytes，截断数为 0。没有下载清单外的对象，没有删除任何既有文件。',
      title_parts[1], title_parts[2]
    );
    IF p_acceptance_criteria IS DISTINCT FROM expected_criteria THEN
      RETURN QUERY SELECT NULL::text, NULL::text,
        'WARC 验收文字与严格模板不一致；未猜测命令。'::text;
      RETURN;
    END IF;

    command_template := $command$set -eu
python3 - '__DUMP__' '__SHARD__' <<'PY'
import json
import subprocess
import sys
from pathlib import Path

dump, shard = sys.argv[1:]
manifest = Path(f"/data/wikova/common-crawl/.fineweb-warc-tasks/manifests/{dump}__{shard}.json")
status = Path(f"/data/wikova/common-crawl/.fineweb-warc-tasks/status/{dump}__{shard}.json")
doc = json.loads(manifest.read_text(encoding="utf-8"))
warcs = doc.get("warcs")
assert isinstance(warcs, list), "manifest warcs is not a list"
paths = [item.get("path") for item in warcs if isinstance(item, dict)]
assert len(paths) == len(warcs) and all(isinstance(path, str) and path for path in paths), "manifest path missing"
assert len(paths) == len(set(paths)), "manifest contains duplicate WARC paths"
assert all(isinstance(item.get("size_bytes"), int) and item["size_bytes"] >= 0 for item in warcs), "manifest size_bytes invalid"
proc = subprocess.run(
    ["python3", "/data/wikova/bin/warc_inventory.py", "--dump", dump, "--shard", shard],
    stdout=subprocess.PIPE,
    stderr=subprocess.STDOUT,
    text=True,
)
print(proc.stdout, end="")
assert proc.returncode == 0, f"warc_inventory exit {proc.returncode}"
assert "齐全，可直接 merge" in proc.stdout, "inventory did not report complete"
state = json.loads(status.read_text(encoding="utf-8"))
assert isinstance(state, dict), "WARC status is not an object"
for field in ("warc_count", "total_bytes", "downloaded", "reused", "started_at", "finished_at"):
    assert field in state, f"WARC status missing {field}"
def count(value, field):
    if isinstance(value, int):
        return value
    if isinstance(value, list):
        return len(value)
    raise AssertionError(f"WARC status {field} is neither count nor list")
downloaded = count(state["downloaded"], "downloaded")
reused = count(state["reused"], "reused")
assert state["warc_count"] == len(warcs), "status warc_count disagrees with manifest"
assert state["total_bytes"] == sum(item["size_bytes"] for item in warcs), "status total_bytes disagrees with manifest"
assert downloaded + reused == len(warcs), "downloaded + reused disagrees with manifest"
print(json.dumps({
    "stage": "WARC",
    "dump": dump,
    "shard": shard,
    "warc_count": len(warcs),
    "downloaded": downloaded,
    "reused": reused,
    "truncated": 0,
}, ensure_ascii=False, sort_keys=True))
PY$command$;
    command_template := replace(command_template, '__DUMP__', title_parts[1]);
    command_template := replace(command_template, '__SHARD__', title_parts[2]);
    RETURN QUERY SELECT 'WARC'::text, command_template, NULL::text;
    RETURN;
  END IF;

  title_parts := regexp_match(
    p_title,
    '^\[Merge\]\[(CC-MAIN-[0-9]{4}-[0-9]{2})\] ([0-9]{3}_[0-9]{5}) → RocksDB$'
  );
  IF title_parts IS NOT NULL THEN
    expected_criteria := format(
      '/data/wikova/corpus/data/%s/%s.rocksdb/ 存在且能用 rocksdict 打开，含四个 CF；构建目录与 .incoming 都已不存在；/data/wikova/corpus/.merge-tasks/status/%s__%s.json 已写且 missing_rate ≤ 0.05；随机抽 20 条能从三个主 CF 取回且 text 与 Parquet 原值逐字节一致；warc_index 非空。',
      title_parts[1], title_parts[2], title_parts[1], title_parts[2]
    );
    IF p_acceptance_criteria IS DISTINCT FROM expected_criteria THEN
      RETURN QUERY SELECT NULL::text, NULL::text,
        'Merge 验收文字与严格模板不一致；未猜测命令。'::text;
      RETURN;
    END IF;

    command_template := $command$set -eu
python3 - '__DUMP__' '__SHARD__' <<'PY'
import json
import random
import re
import sys
from pathlib import Path
from pyarrow.parquet import ParquetFile
from rocksdict import AccessType, Rdict
from surt import surt

dump, shard = sys.argv[1:]
db_path = Path(f"/data/wikova/corpus/data/{dump}/{shard}.rocksdb")
build_path = Path(f"/data/tmp/fineweb-build/{dump}__{shard}.rocksdb")
incoming_path = Path(f"/data/wikova/corpus/data/{dump}/.{shard}.rocksdb.incoming")
status_path = Path(f"/data/wikova/corpus/.merge-tasks/status/{dump}__{shard}.json")
tmp_parquet = Path(f"/data/tmp/fineweb/data/{dump}/{shard}.parquet")
final_parquet = Path(f"/data/wikova/fineweb/data/{dump}/{shard}.parquet")
assert db_path.is_dir(), f"missing RocksDB: {db_path}"
assert not build_path.exists(), f"build directory remains: {build_path}"
assert not incoming_path.exists(), f"incoming directory remains: {incoming_path}"
state = json.loads(status_path.read_text(encoding="utf-8"))
rate = state.get("missing_rate")
assert isinstance(rate, (int, float)) and not isinstance(rate, bool), "status missing_rate invalid"
assert rate <= 0.05, f"missing_rate {rate} > 0.05"
parquet = tmp_parquet if tmp_parquet.is_file() else final_parquet
assert parquet.is_file(), "neither working nor final Parquet exists"
pf = ParquetFile(parquet)
row_count = pf.metadata.num_rows
assert row_count > 0, "Parquet has no rows"

def timestamp14(value):
    if hasattr(value, "strftime"):
        return value.strftime("%Y%m%d%H%M%S")
    digits = re.sub(r"[^0-9]", "", str(value))
    assert len(digits) >= 14, f"date has fewer than 14 digits: {value!r}"
    return digits[:14]

sample_ids = sorted(random.Random(f"{dump}/{shard}/merge-v1").sample(range(row_count), min(20, row_count)))
row_groups = []
offset = 0
for index in range(pf.metadata.num_row_groups):
    size = pf.metadata.row_group(index).num_rows
    row_groups.append((offset, offset + size, index))
    offset += size
rows = []
for start, end, group_index in row_groups:
    local = [value - start for value in sample_ids if start <= value < end]
    if not local:
        continue
    table = pf.read_row_group(group_index, columns=["url", "date", "text"])
    rows.extend(table.slice(index, 1).to_pylist()[0] for index in local)
assert len(rows) == len(sample_ids), "could not materialize all sampled Parquet rows"

names = [name.decode() if isinstance(name, bytes) else str(name) for name in Rdict.list_cf(str(db_path))]
required = {"default", "text", "html", "warc_index"}
assert required.issubset(set(names)), f"column families {names!r} do not contain {sorted(required)!r}"
db = Rdict(str(db_path), access_type=AccessType.read_only())
try:
    default_cf = db.get_column_family("default")
    text_cf = db.get_column_family("text")
    html_cf = db.get_column_family("html")
    warc_cf = db.get_column_family("warc_index")
    for row in rows:
        key = f"{surt(row['url'])} {timestamp14(row['date'])}".encode("utf-8")
        default_value = default_cf.get(key)
        text_value = text_cf.get(key)
        html_value = html_cf.get(key)
        assert default_value is not None, f"default missing {key!r}"
        assert text_value is not None, f"text missing {key!r}"
        assert html_value is not None, f"html missing {key!r}"
        expected_text = row["text"]
        if isinstance(expected_text, str):
            expected_text = expected_text.encode("utf-8")
        assert text_value == expected_text, f"text mismatch {key!r}"
    assert next(iter(warc_cf.items()), None) is not None, "warc_index is empty"
finally:
    db.close()
print(json.dumps({
    "stage": "Merge",
    "dump": dump,
    "shard": shard,
    "column_families": sorted(names),
    "missing_rate": rate,
    "sampled_rows": len(rows),
    "warc_index_nonempty": True,
}, ensure_ascii=False, sort_keys=True))
PY$command$;
    command_template := replace(command_template, '__DUMP__', title_parts[1]);
    command_template := replace(command_template, '__SHARD__', title_parts[2]);
    RETURN QUERY SELECT 'MERGE'::text, command_template, NULL::text;
    RETURN;
  END IF;

  title_parts := regexp_match(
    p_title,
    '^\[校验\]\[(CC-MAIN-[0-9]{4}-[0-9]{2})\] ([0-9]{3}_[0-9]{5})\.rocksdb$'
  );
  IF title_parts IS NOT NULL THEN
    expected_criteria := format(
      '四项校验都有明确数字写进任务结果（条目数差值与缺失率、200 条回读、20 条字段比对、体积与 SST 数）；warc_index 抽 5 条按 (w,o,l) 做 Range 读能解析出完整 response 且 URL 与 key 相符；Parquet 已在 /data/wikova/fineweb/data/%s/%s.parquet；warc_reclaim.py 已执行并报告删除数与释放字节。校验不通过时必须说明未归位、未回收，且 /data/wikova/corpus/data/%s/%s.rocksdb/ 保持原样。',
      title_parts[1], title_parts[2], title_parts[1], title_parts[2]
    );
    IF p_acceptance_criteria IS DISTINCT FROM expected_criteria THEN
      RETURN QUERY SELECT NULL::text, NULL::text,
        '校验验收文字与严格模板不一致；未猜测命令。'::text;
      RETURN;
    END IF;

    command_template := $command$set -eu
python3 - '__DUMP__' '__SHARD__' <<'PY'
import io
import json
import math
import random
import re
import subprocess
import sys
import urllib.request
from html.parser import HTMLParser
from pathlib import Path
from pyarrow.parquet import ParquetFile
from rocksdict import AccessType, Rdict
from surt import surt
from warcio.archiveiterator import ArchiveIterator

dump, shard = sys.argv[1:]
db_path = Path(f"/data/wikova/corpus/data/{dump}/{shard}.rocksdb")
parquet = Path(f"/data/wikova/fineweb/data/{dump}/{shard}.parquet")
working_parquet = Path(f"/data/tmp/fineweb/data/{dump}/{shard}.parquet")
assert db_path.is_dir(), f"missing RocksDB: {db_path}"
assert parquet.is_file(), f"Parquet was not moved to final path: {parquet}"
assert not working_parquet.exists(), f"working Parquet remains: {working_parquet}"
pf = ParquetFile(parquet)
parquet_rows = pf.metadata.num_rows
assert parquet_rows > 0, "Parquet has no rows"

def timestamp14(value):
    if hasattr(value, "strftime"):
        return value.strftime("%Y%m%d%H%M%S")
    digits = re.sub(r"[^0-9]", "", str(value))
    assert len(digits) >= 14, f"date has fewer than 14 digits: {value!r}"
    return digits[:14]

class TagProbe(HTMLParser):
    def __init__(self):
        super().__init__()
        self.tags = 0
    def handle_starttag(self, tag, attrs):
        self.tags += 1

def sampled_parquet_rows(limit):
    candidate_count = min(parquet_rows, max(limit * 20, 4000))
    indices = sorted(random.Random(f"{dump}/{shard}/verify-v1").sample(range(parquet_rows), candidate_count))
    groups = []
    offset = 0
    for group_index in range(pf.metadata.num_row_groups):
        size = pf.metadata.row_group(group_index).num_rows
        groups.append((offset, offset + size, group_index))
        offset += size
    rows = []
    columns = ["id", "url", "date", "language_score", "file_path", "text"]
    for start, end, group_index in groups:
        local = [value - start for value in indices if start <= value < end]
        if not local:
            continue
        table = pf.read_row_group(group_index, columns=columns)
        rows.extend(table.slice(index, 1).to_pylist()[0] for index in local)
    return rows

names = [name.decode() if isinstance(name, bytes) else str(name) for name in Rdict.list_cf(str(db_path))]
required = {"default", "text", "html", "warc_index"}
assert required.issubset(set(names)), f"column families {names!r} do not contain {sorted(required)!r}"
db = Rdict(str(db_path), access_type=AccessType.read_only())
range_results = []
try:
    default_cf = db.get_column_family("default")
    text_cf = db.get_column_family("text")
    html_cf = db.get_column_family("html")
    warc_cf = db.get_column_family("warc_index")
    handles = {
        "default": default_cf,
        "text": text_cf,
        "html": html_cf,
        "warc_index": warc_cf,
    }
    cf_counts = {name: len(handle) for name, handle in handles.items()}
    assert cf_counts["default"] == cf_counts["text"] == cf_counts["html"], "three main CF counts differ"
    missing = parquet_rows - cf_counts["default"]
    missing_rate = missing / parquet_rows
    assert missing >= 0 and missing_rate <= 0.05, f"main CF missing_rate {missing_rate} outside [0, 0.05]"
    cf_sizes = {}
    cf_sst_bytes = {}
    for name, handle in handles.items():
        live = handle.property_int_value("rocksdb.estimate-live-data-size")
        sst = handle.property_int_value("rocksdb.total-sst-files-size")
        assert isinstance(live, int) and live >= 0, f"{name} live-data-size unavailable"
        assert isinstance(sst, int) and sst >= 0, f"{name} total-sst-files-size unavailable"
        cf_sizes[name] = live
        cf_sst_bytes[name] = sst

    verified = []
    for row in sampled_parquet_rows(200):
        key = f"{surt(row['url'])} {timestamp14(row['date'])}".encode("utf-8")
        default_value = default_cf.get(key)
        if default_value is None:
            continue
        text_value = text_cf.get(key)
        html_value = html_cf.get(key)
        assert text_value is not None, f"text missing {key!r}"
        assert html_value is not None and len(html_value) > 0, f"html missing/empty {key!r}"
        expected_text = row["text"]
        if isinstance(expected_text, str):
            expected_text = expected_text.encode("utf-8")
        assert text_value == expected_text, f"text mismatch {key!r}"
        metadata = json.loads(default_value)
        assert str(metadata.get("id")) == str(row["id"]), f"id mismatch {key!r}"
        assert metadata.get("url") == row["url"], f"url mismatch {key!r}"
        assert timestamp14(metadata.get("date")) == timestamp14(row["date"]), f"date mismatch {key!r}"
        assert metadata.get("file_path") == row["file_path"], f"file_path mismatch {key!r}"
        stored_score = metadata.get("language_score")
        expected_score = row["language_score"]
        if stored_score is None or expected_score is None:
            assert stored_score is expected_score, f"language_score null mismatch {key!r}"
        else:
            assert math.isclose(float(stored_score), float(expected_score), rel_tol=0.0, abs_tol=0.0), f"language_score mismatch {key!r}"
        probe = TagProbe()
        probe.feed(html_value.decode("utf-8", errors="replace"))
        assert probe.tags > 0, f"html has no parseable tag {key!r}"
        verified.append((key, metadata, row))
        if len(verified) == 200:
            break
    assert len(verified) == 200, f"only {len(verified)} complete sampled rows, expected 200"
    for key, metadata, row in verified[:20]:
        assert metadata["url"] == row["url"]
        assert timestamp14(metadata["date"]) == timestamp14(row["date"])
        assert metadata["file_path"] == row["file_path"]

    warc_samples = []
    for key, value in warc_cf.items():
        warc_samples.append((key, value))
        if len(warc_samples) == 5:
            break
    assert len(warc_samples) == 5, "warc_index has fewer than 5 entries"
    for key, value in warc_samples:
        coordinate = json.loads(value)
        warc_path = coordinate.get("w")
        offset = coordinate.get("o")
        length = coordinate.get("l")
        assert isinstance(warc_path, str) and warc_path, "warc_index w invalid"
        assert isinstance(offset, int) and offset >= 0, "warc_index o invalid"
        assert isinstance(length, int) and length > 0, "warc_index l invalid"
        local = next((path for path in (
            Path("/data/tmp/common-crawl") / warc_path,
            Path("/data/wikova/common-crawl") / warc_path,
        ) if path.is_file()), None)
        source = "local"
        if local is not None:
            with local.open("rb") as stream:
                stream.seek(offset)
                payload = stream.read(length)
        else:
            source = "commoncrawl-range"
            request = urllib.request.Request(
                f"https://data.commoncrawl.org/{warc_path}",
                headers={"Range": f"bytes={offset}-{offset + length - 1}"},
            )
            with urllib.request.urlopen(request, timeout=60) as response:
                payload = response.read()
        assert len(payload) == length, f"Range length {len(payload)} != {length}"
        record = next(iter(ArchiveIterator(io.BytesIO(payload))))
        assert record.rec_type == "response", f"Range record type {record.rec_type!r}"
        target = record.rec_headers.get_header("WARC-Target-URI")
        warc_date = record.rec_headers.get_header("WARC-Date")
        expected_key = f"{surt(target)} {timestamp14(warc_date)}".encode("utf-8")
        assert expected_key == key, f"Range URL/date does not match key {key!r}"
        range_results.append({"key": key.decode("utf-8"), "source": source, "bytes": len(payload)})
finally:
    db.close()

reclaim = subprocess.run(
    ["python3", "/data/wikova/bin/warc_reclaim.py", "--dump", dump, "--shard", shard, "--verified", "--dry-run"],
    stdout=subprocess.PIPE,
    stderr=subprocess.STDOUT,
    text=True,
)
print(reclaim.stdout, end="")
assert reclaim.returncode == 0, f"warc_reclaim dry-run exit {reclaim.returncode}"
assert reclaim.stdout.strip(), "warc_reclaim dry-run produced no accounting output"
disk_bytes = sum(path.stat().st_size for path in db_path.rglob("*") if path.is_file())
sst_files = sum(1 for path in db_path.rglob("*.sst") if path.is_file())
print(json.dumps({
    "stage": "校验",
    "dump": dump,
    "shard": shard,
    "parquet_rows": parquet_rows,
    "cf_counts": cf_counts,
    "count_difference": missing,
    "missing_rate": missing_rate,
    "readback_sample": 200,
    "field_compare_sample": 20,
    "db_disk_bytes": disk_bytes,
    "cf_live_data_bytes": cf_sizes,
    "cf_sst_bytes": cf_sst_bytes,
    "sst_files": sst_files,
    "warc_range_sample": range_results,
    "reclaim_dry_run_exit": reclaim.returncode,
}, ensure_ascii=False, sort_keys=True))
PY$command$;
    command_template := replace(command_template, '__DUMP__', title_parts[1]);
    command_template := replace(command_template, '__SHARD__', title_parts[2]);
    RETURN QUERY SELECT 'VERIFY'::text, command_template, NULL::text;
    RETURN;
  END IF;

  IF p_title ~ '^\[(FineWeb|WARC|Merge|校验)\]' THEN
    RETURN QUERY SELECT NULL::text, NULL::text,
      '标题不符合对应前缀的严格 dump/shard 模板；未猜测命令。'::text;
    RETURN;
  END IF;

  RETURN QUERY SELECT NULL::text, NULL::text,
    CASE
      WHEN p_acceptance_criteria IS NULL OR btrim(p_acceptance_criteria) = ''
        THEN '无可判定的标题前缀且没有验收标准；保持 HUMAN_SIGNOFF。'
      ELSE '无可判定的标题前缀；保持 HUMAN_SIGNOFF。'
    END::text;
END;
$function$;

CREATE FUNCTION "n19_fineweb_executable_inventory"(p_project_id uuid)
RETURNS TABLE (
  task_id uuid,
  title text,
  status "task_status",
  completion_criterion "task_completion_criterion",
  task_class text,
  will_migrate boolean,
  reason text,
  acceptance_command text
) LANGUAGE sql STABLE AS $function$
  SELECT
    task."id",
    task."title",
    task."status",
    task."completion_criterion",
    classified.task_class,
    (
      task."status" = 'OPEN'
      AND task."completion_criterion" = 'HUMAN_SIGNOFF'
      AND task."acceptance_command" IS NULL
      AND task."acceptance_expected_exit_code" IS NULL
      AND task."completion_policy" = 'MANUAL'
      AND task."verifies_task_id" IS NULL
      AND classified.task_class IS NOT NULL
    ) AS will_migrate,
    CASE
      WHEN task."status" <> 'OPEN' THEN '源状态不是 OPEN；未迁移。'
      WHEN task."completion_criterion" <> 'HUMAN_SIGNOFF'
        OR task."acceptance_command" IS NOT NULL
        OR task."acceptance_expected_exit_code" IS NOT NULL
        THEN '源判据不再是未配置命令的 HUMAN_SIGNOFF；未覆盖并发修改。'
      WHEN task."completion_policy" <> 'MANUAL' OR task."verifies_task_id" IS NOT NULL
        THEN '源任务不是独立 MANUAL 判据；未迁移。'
      ELSE classified.reason
    END,
    classified.acceptance_command
  FROM "task" task
  CROSS JOIN LATERAL "n19_fineweb_executable_classify"(
    task."title", task."description", task."acceptance_criteria"
  ) classified
  WHERE task."project_id" = p_project_id
  ORDER BY task."id";
$function$;

CREATE FUNCTION "n19_fineweb_executable_prepare"(
  p_project_id uuid,
  p_idempotency_key text,
  p_batch_size integer
) RETURNS jsonb LANGUAGE plpgsql AS $function$
DECLARE
  existing "task_executable_backfill_batch"%ROWTYPE;
  project_title text;
  upper_bound uuid;
  source_count bigint;
  candidate_count bigint;
  unclassified_count bigint;
  class_counts jsonb;
  status_counts jsonb;
  batch_id uuid;
BEGIN
  IF p_batch_size < 1 OR p_batch_size > 1000 THEN
    RAISE EXCEPTION 'N19_BATCH_SIZE_OUT_OF_RANGE';
  END IF;
  IF p_idempotency_key IS NULL OR length(btrim(p_idempotency_key)) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'N19_IDEMPOTENCY_KEY_REQUIRED';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('n19-fineweb:' || p_project_id::text, 0));

  SELECT * INTO existing
    FROM "task_executable_backfill_batch"
   WHERE "project_id" = p_project_id AND "idempotency_key" = p_idempotency_key;
  IF FOUND THEN
    IF existing."batch_size" <> p_batch_size OR existing."command_version" <> 'n19-v1' THEN
      RAISE EXCEPTION 'N19_IDEMPOTENCY_INPUT_MISMATCH';
    END IF;
    RETURN to_jsonb(existing);
  END IF;

  SELECT "title" INTO project_title FROM "project" WHERE "id" = p_project_id FOR SHARE;
  IF NOT FOUND OR project_title <> 'FineWeb × Common Crawl → RocksDB 语料库' THEN
    RAISE EXCEPTION 'N19_FINEWEB_PROJECT_REQUIRED';
  END IF;
  SELECT "id" INTO upper_bound
    FROM "task"
   WHERE "project_id" = p_project_id
   ORDER BY "id" DESC
   LIMIT 1;
  IF upper_bound IS NULL THEN
    RAISE EXCEPTION 'N19_PROJECT_HAS_NO_TASKS';
  END IF;

  WITH inventory AS MATERIALIZED (
    SELECT * FROM "n19_fineweb_executable_inventory"(p_project_id)
     WHERE task_id <= upper_bound
  )
  SELECT
    count(*),
    count(*) FILTER (WHERE will_migrate),
    count(*) FILTER (WHERE NOT will_migrate)
  INTO source_count, candidate_count, unclassified_count
  FROM inventory;

  SELECT coalesce(jsonb_object_agg(bucket, amount ORDER BY bucket), '{}'::jsonb)
    INTO class_counts
    FROM (
      SELECT
        CASE WHEN will_migrate THEN task_class ELSE 'UNCLASSIFIED' END AS bucket,
        count(*) AS amount
      FROM "n19_fineweb_executable_inventory"(p_project_id)
      WHERE task_id <= upper_bound
      GROUP BY 1
    ) grouped;

  SELECT coalesce(jsonb_object_agg("status"::text, amount ORDER BY "status"::text), '{}'::jsonb)
    INTO status_counts
    FROM (
      SELECT "status", count(*) AS amount
        FROM "task"
       WHERE "project_id" = p_project_id AND "id" <= upper_bound
       GROUP BY "status"
    ) grouped;

  INSERT INTO "task_executable_backfill_batch" (
    "project_id", "idempotency_key", "command_version", "batch_size",
    "upper_bound_task_id", "source_task_count", "candidate_count", "unclassified_count",
    "class_counts", "pre_status_counts"
  ) VALUES (
    p_project_id, btrim(p_idempotency_key), 'n19-v1', p_batch_size,
    upper_bound, source_count, candidate_count, unclassified_count,
    class_counts, status_counts
  ) RETURNING "id" INTO batch_id;

  RETURN (
    SELECT to_jsonb(batch_row)
      FROM "task_executable_backfill_batch" batch_row
     WHERE batch_row."id" = batch_id
  );
END;
$function$;

CREATE FUNCTION "n19_fineweb_executable_backfill_step"(p_batch_id uuid)
RETURNS TABLE (
  batch_id uuid,
  batch_number integer,
  rows_migrated integer,
  total_migrated bigint,
  finished boolean,
  duration_ms bigint
) LANGUAGE plpgsql AS $function$
#variable_conflict use_column
DECLARE
  batch_row "task_executable_backfill_batch"%ROWTYPE;
  selected_last_id uuid;
  changed integer;
  ledger_count bigint;
  status_counts jsonb;
  call_started timestamptz := clock_timestamp();
BEGIN
  SELECT * INTO batch_row
    FROM "task_executable_backfill_batch"
   WHERE "id" = p_batch_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'N19_BATCH_NOT_FOUND';
  END IF;
  IF batch_row."status" = 'FINISHED' THEN
    RETURN QUERY SELECT batch_row."id", batch_row."batch_count", 0,
      batch_row."migrated_count", true, 0::bigint;
    RETURN;
  END IF;
  IF batch_row."status" <> 'RUNNING' THEN
    RAISE EXCEPTION 'N19_BATCH_NOT_RUNNING';
  END IF;

  WITH candidate AS MATERIALIZED (
    SELECT
      task."id",
      task."status",
      task."completion_criterion",
      task."acceptance_command",
      task."acceptance_expected_exit_code",
      classified.task_class,
      classified.acceptance_command AS installed_command
    FROM "task" task
    CROSS JOIN LATERAL "n19_fineweb_executable_classify"(
      task."title", task."description", task."acceptance_criteria"
    ) classified
    WHERE task."project_id" = batch_row."project_id"
      AND task."id" > coalesce(batch_row."last_task_id", '00000000-0000-0000-0000-000000000000'::uuid)
      AND task."id" <= batch_row."upper_bound_task_id"
      AND task."status" = 'OPEN'
      AND task."completion_criterion" = 'HUMAN_SIGNOFF'
      AND task."acceptance_command" IS NULL
      AND task."acceptance_expected_exit_code" IS NULL
      AND task."completion_policy" = 'MANUAL'
      AND task."verifies_task_id" IS NULL
      AND classified.task_class IS NOT NULL
    ORDER BY task."id"
    LIMIT batch_row."batch_size"
    FOR UPDATE OF task SKIP LOCKED
  ), captured AS (
    INSERT INTO "task_executable_backfill_item" (
      "batch_id", "task_id", "task_class", "previous_status",
      "previous_completion_criterion", "previous_acceptance_command",
      "previous_expected_exit_code", "installed_acceptance_command_sha256",
      "installed_expected_exit_code"
    )
    SELECT
      batch_row."id", candidate."id", candidate.task_class, candidate."status",
      candidate."completion_criterion", candidate."acceptance_command",
      candidate."acceptance_expected_exit_code",
      encode(digest(candidate.installed_command, 'sha256'), 'hex'), 0
    FROM candidate
    ON CONFLICT ON CONSTRAINT "task_executable_backfill_item_pkey" DO NOTHING
    RETURNING "task_id"
  ), updated AS (
    UPDATE "task" task
       SET "completion_criterion" = 'EXECUTABLE',
           "acceptance_command" = candidate.installed_command,
           "acceptance_expected_exit_code" = 0,
           "updated_at" = statement_timestamp()
      FROM candidate
      JOIN captured ON captured."task_id" = candidate."id"
     WHERE task."id" = candidate."id"
       AND task."status" = 'OPEN'
       AND task."completion_criterion" = 'HUMAN_SIGNOFF'
       AND task."acceptance_command" IS NULL
       AND task."acceptance_expected_exit_code" IS NULL
    RETURNING task."id"
  )
  SELECT count(*)::integer, (array_agg("id" ORDER BY "id" DESC))[1]
    INTO changed, selected_last_id
    FROM updated;

  IF changed > 0 THEN
    UPDATE "task_executable_backfill_batch"
       SET "last_task_id" = selected_last_id,
           "batch_count" = "batch_count" + 1,
           "migrated_count" = "migrated_count" + changed
     WHERE "id" = batch_row."id";
    RETURN QUERY SELECT
      batch_row."id",
      batch_row."batch_count" + 1,
      changed,
      batch_row."migrated_count" + changed,
      false,
      floor(extract(epoch FROM (clock_timestamp() - call_started)) * 1000)::bigint;
    RETURN;
  END IF;

  SELECT count(*) INTO ledger_count
    FROM "task_executable_backfill_item"
   WHERE "batch_id" = batch_row."id";
  IF ledger_count <> batch_row."candidate_count" THEN
    RAISE EXCEPTION 'N19_SCOPE_DRIFT expected % migrated rows but ledger has %',
      batch_row."candidate_count", ledger_count;
  END IF;
  SELECT coalesce(jsonb_object_agg("status"::text, amount ORDER BY "status"::text), '{}'::jsonb)
    INTO status_counts
    FROM (
      SELECT "status", count(*) AS amount
        FROM "task"
       WHERE "project_id" = batch_row."project_id"
         AND "id" <= batch_row."upper_bound_task_id"
       GROUP BY "status"
    ) grouped;
  UPDATE "task_executable_backfill_batch"
     SET "status" = 'FINISHED',
         "finished_at" = clock_timestamp(),
         "post_status_counts" = status_counts
   WHERE "id" = batch_row."id";
  RETURN QUERY SELECT
    batch_row."id",
    batch_row."batch_count",
    0,
    ledger_count,
    true,
    floor(extract(epoch FROM (clock_timestamp() - call_started)) * 1000)::bigint;
END;
$function$;

CREATE FUNCTION "n19_fineweb_executable_rollback_step"(p_batch_id uuid)
RETURNS TABLE (
  batch_id uuid,
  rows_rolled_back integer,
  total_rolled_back bigint,
  finished boolean,
  duration_ms bigint
) LANGUAGE plpgsql AS $function$
#variable_conflict use_column
DECLARE
  batch_row "task_executable_backfill_batch"%ROWTYPE;
  task_ids uuid[];
  drift_count integer;
  changed integer;
  remaining bigint;
  call_started timestamptz := clock_timestamp();
BEGIN
  SELECT * INTO batch_row
    FROM "task_executable_backfill_batch"
   WHERE "id" = p_batch_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'N19_BATCH_NOT_FOUND';
  END IF;
  IF batch_row."status" = 'ROLLED_BACK' THEN
    RETURN QUERY SELECT batch_row."id", 0, batch_row."rolled_back_count", true, 0::bigint;
    RETURN;
  END IF;
  IF batch_row."status" NOT IN ('RUNNING', 'FINISHED', 'ROLLING_BACK') THEN
    RAISE EXCEPTION 'N19_BATCH_NOT_ROLLBACKABLE';
  END IF;
  UPDATE "task_executable_backfill_batch" SET "status" = 'ROLLING_BACK'
   WHERE "id" = batch_row."id";

  SELECT array_agg("task_id" ORDER BY "task_id") INTO task_ids
    FROM (
      SELECT "task_id"
        FROM "task_executable_backfill_item"
       WHERE "batch_id" = batch_row."id" AND "rolled_back_at" IS NULL
       ORDER BY "task_id"
       LIMIT batch_row."batch_size"
    ) selected;
  IF task_ids IS NULL THEN
    UPDATE "task_executable_backfill_batch"
       SET "status" = 'ROLLED_BACK', "rolled_back_at" = clock_timestamp()
     WHERE "id" = batch_row."id";
    RETURN QUERY SELECT batch_row."id", 0, batch_row."rolled_back_count", true,
      floor(extract(epoch FROM (clock_timestamp() - call_started)) * 1000)::bigint;
    RETURN;
  END IF;

  PERFORM 1 FROM "task" WHERE "id" = ANY(task_ids) ORDER BY "id" FOR UPDATE;
  SELECT count(*)::integer INTO drift_count
    FROM "task_executable_backfill_item" item
    JOIN "task" task ON task."id" = item."task_id"
   WHERE item."batch_id" = batch_row."id"
     AND item."task_id" = ANY(task_ids)
     AND (
       task."status" IS DISTINCT FROM item."previous_status"
       OR task."completion_criterion" IS DISTINCT FROM 'EXECUTABLE'::"task_completion_criterion"
       OR encode(digest(task."acceptance_command", 'sha256'), 'hex')
          IS DISTINCT FROM item."installed_acceptance_command_sha256"
       OR task."acceptance_expected_exit_code" IS DISTINCT FROM item."installed_expected_exit_code"
     );
  IF drift_count > 0 THEN
    RAISE EXCEPTION 'N19_ROLLBACK_DRIFT % row(s) changed after migration', drift_count;
  END IF;

  WITH restored AS (
    UPDATE "task" task
       SET "completion_criterion" = item."previous_completion_criterion",
           "acceptance_command" = item."previous_acceptance_command",
           "acceptance_expected_exit_code" = item."previous_expected_exit_code",
           "updated_at" = statement_timestamp()
      FROM "task_executable_backfill_item" item
     WHERE item."batch_id" = batch_row."id"
       AND item."task_id" = ANY(task_ids)
       AND task."id" = item."task_id"
    RETURNING task."id"
  ), marked AS (
    UPDATE "task_executable_backfill_item" item
       SET "rolled_back_at" = clock_timestamp()
     WHERE item."batch_id" = batch_row."id"
       AND item."task_id" IN (SELECT "id" FROM restored)
    RETURNING item."task_id"
  )
  SELECT count(*)::integer INTO changed FROM marked;

  UPDATE "task_executable_backfill_batch"
     SET "rolled_back_count" = "rolled_back_count" + changed
   WHERE "id" = batch_row."id";
  SELECT count(*) INTO remaining
    FROM "task_executable_backfill_item"
   WHERE "batch_id" = batch_row."id" AND "rolled_back_at" IS NULL;
  IF remaining = 0 THEN
    UPDATE "task_executable_backfill_batch"
       SET "status" = 'ROLLED_BACK', "rolled_back_at" = clock_timestamp()
     WHERE "id" = batch_row."id";
  END IF;
  RETURN QUERY SELECT
    batch_row."id",
    changed,
    batch_row."rolled_back_count" + changed,
    remaining = 0,
    floor(extract(epoch FROM (clock_timestamp() - call_started)) * 1000)::bigint;
END;
$function$;

COMMENT ON FUNCTION "n19_fineweb_executable_backfill_step"(uuid) IS
  'N19 operator door: one call updates at most batch_size OPEN tasks and never writes task.status.';
COMMENT ON FUNCTION "n19_fineweb_executable_rollback_step"(uuid) IS
  'N19 rollback door: one call restores at most batch_size declarations and refuses status/declaration drift.';
