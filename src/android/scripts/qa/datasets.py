#!/usr/bin/env python3
"""A02c: the A01 v1 §6 QA datasets DS0, DS1, DS2 and DS6, rebuilt from the seed `orbit-android-a01-v1`.

  python3 datasets.py generate OUT [DS0 DS1 DS2 DS6]   write OUT/<dataset>/… and OUT/SHA256SUMS
  python3 datasets.py verify OUT                       re-hash OUT; compare with OUT/SHA256SUMS and datasets.sha256

Synthetic only: no production row, account or credential. Every value is a function of the seed and of
its own key through SHA-256 — never of the clock, the host, the order things are generated in or Python's
`random` — so two runs write the same bytes, and adding a field moves no other value. Bodies are in the
real apiserver's wire shape (README.md): ids leave as base62 with their publicId twins, workspace fields
are mirrored as agent ones, and nullable columns are sent as null. dataset-server.py serves a dataset.
"""
import argparse
import hashlib
import json
import re
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import images  # noqa: E402

SEED = 'orbit-android-a01-v1'
GENERATOR = 'a02c-datasets'
VERSION = 1
SOURCES = ('datasets.py', 'images.py')
PINNED = HERE / 'datasets.sha256'
DATASETS = ('DS0', 'DS1', 'DS2', 'DS6')
# The datasets' "now": every timestamp is at or before it, so a reader sees the same ages on any day.
ANCHOR = 1792929600000  # 2026-10-25T12:00:00.000Z
SECOND, MINUTE, HOUR, DAY = 1000, 60_000, 3_600_000, 86_400_000
# The Android cache keeps a directory only if its JSON fits in 8 MiB (RealtimeCache.MAX_BYTES).
CACHE_LIMIT = 8 * 1024 * 1024
PASSWORD = 'orbit-a01-fixture'  # the fixture accounts' password; dataset-server.py is loopback-only


# ---------------------------------------------------------------------------------------------- values

def digest(*key):
    return hashlib.sha256('\x1f'.join((SEED,) + tuple(str(k) for k in key)).encode()).digest()


def number(below, *key):
    return int.from_bytes(digest(*key)[:8], 'big') % below


def chance(percent, *key):
    return number(100, *key) < percent


def choose(options, *key):
    return options[number(len(options), *key)]


def iso(ms):
    if ms is None:
        return None
    moment = datetime(1970, 1, 1, tzinfo=timezone.utc) + timedelta(milliseconds=ms)
    return moment.strftime('%Y-%m-%dT%H:%M:%S.') + f'{ms % 1000:03d}Z'


def uuid7(ms, *key):
    """A UUIDv7 (as the server's ids are): its time is `ms`, its random bits come from the key."""
    rand = int.from_bytes(digest('id', *key)[:10], 'big')
    value = (ms & (1 << 48) - 1) << 80 | 7 << 76 | (rand >> 62 & 0xFFF) << 64 | 2 << 62 | rand & (1 << 62) - 1
    text = f'{value:032x}'
    return f'{text[:8]}-{text[8:12]}-{text[12:16]}-{text[16:20]}-{text[20:]}'


BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
UUID = re.compile(r'^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$')


def base62(uuid):
    """@orbit/shared uuidToBase62."""
    n = int(uuid.replace('-', ''), 16)
    out = ''
    while n:
        n, r = divmod(n, 62)
        out = BASE62[r] + out
    return out or '0'


def js_numbers(value):
    """Numbers as JSON.stringify writes them: a float that is a whole number has no fraction (0, not 0.0)."""
    if isinstance(value, float) and value.is_integer():
        return int(value)
    if isinstance(value, dict):
        return {k: js_numbers(v) for k, v in value.items()}
    if isinstance(value, list):
        return [js_numbers(v) for v in value]
    return value


def encode(value):
    return json.dumps(js_numbers(value), ensure_ascii=False, separators=(',', ':')).encode()


# ------------------------------------------------------------------------------------------------ wire

# @orbit/shared PUBLIC_ID_FIELDS, in its order (common/public-id-body.ts walks it to add the twins).
PUBLIC_ID_FIELDS = '''codebaseId id ownerId userId sessionId parentSessionId rootSessionId creatorSessionId
authorSessionId itemId askedBySessionId resolvedBySessionId supersededByItemId integrationJobId promotionId fuseEpisodeId
retryOfJobId retryRequestedBySessionId retryRequestedByUserId handlingItemIds skipApprovedByUserId skipApprovalId
handlingJobId handlingSessionId handlingUserId resolvedByJobId actorSessionId actorUserId nextJobId approvedByUserId
includedTaskIds checkJobId landJobId landingId confirmedByUserId openItemId receiptIds episodeId ownerSessionId
signedById coordinatorSessionId workspaceId workspaceIds credentialId foremanWorkspaceId coordinatorWorkspaceId
defaultWorkspaceId runnerId assignedRunnerId targetRunnerId taskId fixesOpenItemId dependsOnTaskId focusTaskId
sourceTaskId targetTaskId sourceMarkId targetMarkId verifiesTaskId judgmentRequestId supersededByTaskId supersededById
supersededActorId supersededSourceSessionId contextTaskId commentId targetSessionId desiredSessionId verifierTaskId
subjectTaskId defectTaskId resolvedByTaskId runId definitionId criterionId criterionDefinitionId evidenceSessionId
evidenceRunId decidedById confirmedById authoredBySessionId actingSessionId senderSessionId fromSessionId fromTaskId
toSessionId requestTurnId replacedSessionId discoveredFromProjectId sourceSessionId sourceAttemptId evidenceId
decidingSessionId claimId sourceCommentId sourceAuthorId importedById backfillBatchId pushTaskIds inboxItemId
recipientId fromProjectId toProjectId requestedBySessionId decidedByUserId appliedTaskId requestedCriterionDefinitionId
resolvedByUserId resumedByUserId handoffId parentTaskId batchId listId projectId eventId sourceId tagId folderId turnId
targetTurnId inboxRequestTurnId approvalId decisionId shareLinkIds wikiSpaceId templateId delegationId authorityId decisionRequestId
ingestedByRunnerId wakeupId evaluationId firstEvaluationId actionIntentId receiptId diagnosticId coordinationId leaseId
externalWaitId deliveryId resultId completionDeliveryReceiptId waitId planId affectedSessionId originLeaseId
deliveryReceiptId recordedLeaseId wakeIdSnapshot sessionIdSnapshot adoptionId actionId sourceSessionIdSnapshot
taskIdSnapshot taskProjectIdSnapshot lastDeliveryReceiptId bindingId runnerIdSnapshot deliveryBindingId attestationId
verificationId transitionId predecessorEvaluationId successorEvaluationId ratificationId newDecisionRequestId intentId
supersededIntentId tenantId grantId factId causalPredecessorFactId cutId projectDecisionId reporterTaskId
reporterSessionId effectTaskId resultSessionId subjectId assigneeId agentId coordinatorAgentId legacyWorkspaceId
creatorId authorId createdById approvedById updatedById linkUserId actorId mentions tagIds taskIds dependsOnTaskIds
anchorTaskId attachmentIds poolId providerId providerIds poolMemberProviderId contributorId keyId poolKeyId checkpointId
attemptId admissionId mergeCheckpointId baselineCheckpointId wakeId raisedBlockerId routeDecisionId sourceReceiptId
sourceContinuationId lineageRootTaskId successorTaskId committedBySessionId currentSuccessorTaskId rebindId edgeId
dependentTaskId replacementEdgeId sourceCodebaseId sourceResolvedByRunnerId authorityRunnerId watchId matchId
observerSessionId targetResourceId snapshotSourceId spaceId entryId revisionId changesetId changesetOpId resultEntryId
supersedesId toolCallId authorUserId authorToolCallId verificationDuplicateOf duplicateOf topicId parentId entryIds
docId proposalId planDocId planSectionId sectionId sentenceId viaEntryId withdrawnEntryId recordId jobId
requestedByUserId authorJobId reviewId reviewRecordId runSessionId reviewerSessionId opId'''.split()
IRREGULAR = {'id': 'publicId', 'mentions': 'mentionPublicIds', 'duplicateOf': 'duplicateOfPublicId',
             'verificationDuplicateOf': 'verificationDuplicateOfPublicId'}
TWINS = [(f, IRREGULAR.get(f) or re.sub('Id$', 'PublicId', re.sub('Ids$', 'PublicIds', f))) for f in PUBLIC_ID_FIELDS]
ALIASES = (('workspaceId', 'agentId'), ('workspace', 'agent'), ('workspaceName', 'agentName'), ('workspaceIds', 'agentIds'))
SKIP = object()


def _encoded(value):
    if value is None:
        return None
    if isinstance(value, str):
        return base62(value) if UUID.match(value) else SKIP
    if isinstance(value, list) and all(isinstance(v, str) and UUID.match(v) for v in value):
        return [base62(v) for v in value]
    return SKIP


def _twins(value, depth=0):
    if depth > 8 or not isinstance(value, (dict, list)):
        return
    if isinstance(value, list):
        for item in value:
            _twins(item, depth + 1)
        return
    for key in list(value):
        _twins(value[key], depth + 1)
    keys = value.get('antigravityKeyAvailableByRunner')
    if isinstance(keys, dict):
        value['antigravityKeyAvailableByRunner'] = {(base62(k) if UUID.match(k) else k): v for k, v in keys.items()}
    for field, twin in TWINS:
        if field in value:
            out = _encoded(value[field])
            if out is SKIP:
                continue
            if twin not in value:
                value[twin] = out
            if out is not None:
                value[field] = out


def _mirror(value, depth=0):
    if depth > 8 or not isinstance(value, (dict, list)):
        return
    if isinstance(value, list):
        for item in value:
            _mirror(item, depth + 1)
        return
    for key in list(value):
        _mirror(value[key], depth + 1)
    for new, old in ALIASES:
        if new in value and old not in value:
            value[old] = value[new]
        elif old in value and new not in value:
            value[new] = value[old]


def wire(body):
    """A response body as the apiserver sends it: PublicIdInterceptor runs inside WorkspaceAliasInterceptor
    (main.ts), so ids become base62 with a twin first, then workspace* is mirrored as agent*."""
    _twins(body)
    _mirror(body)
    return body


# ------------------------------------------------------------------------------------------------ text

EN_VERBS = ['Fix', 'Add', 'Refactor', 'Investigate', 'Review', 'Update', 'Remove', 'Document', 'Profile', 'Test',
            'Ship', 'Trace', 'Harden', 'Clean up', 'Measure']
EN_OBJECTS = ['login redirect', 'session list paging', 'push token rotation', 'wiki search ranking', 'runner heartbeat',
              'attachment upload retry', 'task dependency graph', 'dark mode contrast', 'SSE reconnect backoff',
              'draft restore after process death', 'folder move sheet', 'project landing card', 'watch expiry copy',
              'composer engine picker', 'release signing check', 'cache eviction order', 'deep link fallback',
              'TalkBack labels on cards', 'table rendering in replies', 'tool output folding']
ZH_TITLES = ['修复登录后跳转', '优化会话列表分页', '排查推送令牌轮换', '重构附件上传重试', '补充中文输入测试',
             '检查深色模式对比度', '更新 Wiki 搜索排序', '整理 Runner 心跳日志', '核对项目落地卡片', '处理进程回收后的草稿',
             '调整文件夹移动面板', '统计长会话内存占用', '验证深链返回路径', '梳理审批卡片状态', '复现断网后重连']
EN_DETAILS = ['It only happens after the app has been in the background for a while.',
              'Keep the behaviour the same as on iOS.', 'Please check the server logs first.',
              'The regression started with the last release.', 'Write down what you measure.',
              'Do not change the public API.', 'Add a test that fails before the fix.']
ZH_DETAILS = ['只有切到后台一段时间后才会出现。', '行为要和 iOS 保持一致。', '先看一下服务端日志。', '上个版本开始出现的回归。',
              '把测到的数据记下来。', '不要改动公开接口。', '先写一个修复前会失败的测试。']
WORDS = ['cache', 'cursor', 'session', 'folder', 'runner', 'token', 'draft', 'anchor', 'retry', 'page', 'stream',
         'snapshot', 'badge', 'card', 'landing', 'watch', 'entry', 'space', 'label', 'scope']
PATHS = ['src/android/app/src/main/kotlin/io/orbitd/android/directory/DirectoryScreen.kt',
         'src/android/core/src/main/kotlin/io/orbitd/android/core/realtime/RealtimeStore.kt',
         'src/android/app/src/main/kotlin/io/orbitd/android/reader/ReaderScreen.kt',
         'src/apiserver/src/sessions/sessions.service.ts', 'src/web/src/pages/SessionPage.tsx',
         'src/macos/OrbitKit/Sources/OrbitKit/App/AppModel.swift', 'src/runner-go/claude.go',
         'src/shared/src/enums.ts', 'docs/android-push-contract.md', 'src/android/app/build.gradle.kts']
COMMANDS = ['./gradlew :app:testDebugUnitTest --tests "*Directory*"', 'npm test -- sessions', 'git status --short',
            'rg -n "lastTurnAt" src', 'go test ./... -run Heartbeat', 'adb logcat -d | tail -n 40',
            'ls -la build/outputs/apk/debug']
TOOLS = ['Read', 'Bash', 'Grep', 'Edit', 'Glob']


def clip(text, length=200):
    return None if text is None else text[:length]


def title_of(*key):
    if chance(35, 'zh-title', *key):
        return choose(ZH_TITLES, 'zh', *key)
    return f"{choose(EN_VERBS, 'verb', *key)} {choose(EN_OBJECTS, 'object', *key)}"


def user_text(title, *key):
    if chance(40, 'zh-user', *key):
        return f"请处理「{title}」。{choose(ZH_DETAILS, 'detail', *key)}"
    return f"Please work on \"{title}\". {choose(EN_DETAILS, 'detail', *key)}"


def code_lines(count, *key):
    lines = []
    for i in range(count):
        word = choose(WORDS, 'code', i, *key)
        kind = number(4, 'code-kind', i, *key)
        if kind == 0:
            lines.append(f'    val {word}{i} = repository.load("{word}-{number(1000, "n", i, *key)}")')
        elif kind == 1:
            lines.append(f'    if ({word}{i - 1 if i else 0}.isEmpty()) return emptyList()')
        elif kind == 2:
            lines.append(f'    // {choose(EN_DETAILS, "comment", i, *key)}')
        else:
            lines.append(f'    {word}Store.update(id = "{word}", at = {number(10_000, "at", i, *key)}L)')
    return lines


def tool_call(index, *key):
    """A tool_use input and its tool_result text."""
    tool = choose(TOOLS, 'tool', index, *key)
    path = choose(PATHS, 'path', index, *key)
    if tool == 'Read':
        lines = code_lines(8 + number(30, 'read-lines', index, *key), 'read', index, *key)
        return tool, {'file_path': '/root/work/' + path}, '\n'.join(f'{n + 1:>6}\t{line}' for n, line in enumerate(lines))
    if tool == 'Bash':
        command = choose(COMMANDS, 'command', index, *key)
        out = [f'> {command}'] + [f'{choose(WORDS, "log", i, index, *key)}: ok ({number(900, "ms", i, index, *key) + 10} ms)'
                                  for i in range(3 + number(12, 'bash-lines', index, *key))]
        return tool, {'command': command, 'description': 'Run the checks'}, '\n'.join(out)
    if tool == 'Grep':
        word = choose(WORDS, 'grep', index, *key)
        hits = [f'{choose(PATHS, "hit", i, index, *key)}:{number(400, "line", i, index, *key) + 1}:    val {word} = load()'
                for i in range(1 + number(8, 'grep-lines', index, *key))]
        return tool, {'pattern': word, 'path': 'src'}, '\n'.join(hits)
    if tool == 'Glob':
        return tool, {'pattern': '**/*.kt'}, '\n'.join(choose(PATHS, 'glob', i, index, *key) for i in range(5))
    old = code_lines(1, 'old', index, *key)[0]
    return tool, {'file_path': '/root/work/' + path, 'old_string': old, 'new_string': old.replace('load', 'loadCached')}, \
        f'The file /root/work/{path} has been updated.'


def assistant_text(final, *key):
    if not final:
        return choose(['Let me look at the code first.', 'I will check where this is handled.', '先看一下相关代码。',
                       'Checking the current behaviour before changing anything.'], 'intro', *key)
    if chance(30, 'zh-final', *key):
        return ('已经处理完。\n\n- 原因：' + choose(ZH_DETAILS, 'cause', *key) + '\n- 修改：调整了 `' + choose(WORDS, 'w', *key)
                + '` 的读取顺序\n- 验证：单测通过')
    rows = ''.join(f'| {choose(WORDS, "row", i, *key)} | {number(100, "v", i, *key)} |\n' for i in range(3))
    return ('Done. **Summary**\n\n1. Found the cause in `' + choose(PATHS, 'p', *key).split('/')[-1] + '`.\n'
            '2. ' + choose(EN_DETAILS, 'd', *key) + '\n\n| Check | Result |\n| --- | ---: |\n' + rows)


# --------------------------------------------------------------------------------------------- records

def user_row(user_id, email, name, role, created):
    """GET /users/me (UsersController.me)."""
    return {'id': user_id, 'email': email, 'name': name, 'createdAt': iso(created), 'preferences': {}, 'role': role,
            'avatarUpdatedAt': None, 'signInMethods': {'password': True, 'google': None}}


def admin_row(user_id, email, name, role, created):
    """A row of GET /admin/users (AdminController)."""
    return {'id': user_id, 'email': email, 'name': name, 'role': role, 'createdAt': iso(created), 'disabledAt': None,
            'avatarUpdatedAt': None, 'signInMethods': {'password': True, 'google': None}, 'lastActive': None}


# antigravityState (apiserver common/antigravity-readiness.ts) of a runner without the Antigravity engine or capability.
ANTIGRAVITY = {'supported': False, 'installed': None, 'version': None, 'envKeyAvailable': False, 'authSource': None,
               'googleLogin': 'needs_update'}


def runner_row(r, owner, workspaces_on):
    """GET /runners: RunnersService.runnerViews."""
    online = r['online']
    beat = ANCHOR - (8 * SECOND if online else 3 * DAY)
    engines = [{'engine': e, 'installed': True, 'version': v, 'auth': 'yes',
                'accounts': [{'id': 'default', 'name': 'Default', 'auth': 'yes'}]} for e, v in r['engines']]
    return {
        'id': r['id'], 'name': r['name'], 'displayName': r['displayName'], 'hostname': r['hostname'],
        'labels': r['labels'], 'status': 'ONLINE' if online else 'OFFLINE', 'maxConcurrent': r['maxConcurrent'],
        'version': '0.1.236', 'lastHeartbeatAt': iso(beat), 'enrolledAt': iso(r['enrolled']), 'position': r['position'],
        'planUsage': None, 'modelCatalog': None, 'runsAsRoot': False, 'minFreeDiskMb': None,
        'reposRoot': '/srv/orbit/repos', 'capabilities': ['session-merge-recovery/v1'], 'heartbeatLeaseOwner': None,
        'heartbeatDraining': False, 'runtimeDefaultModels': {}, 'selfUpdate': None, 'engines': engines,
        'antigravity': dict(ANTIGRAVITY),
        'install': None, 'accountRemove': None, 'online': online, 'activeSessions': workspaces_on,
        'commands': [], 'skills': []}


WORKSPACE_NAMES = ['orbit-android', 'orbit-ios', 'web-console', 'apiserver', 'runner-go', '数据平台', 'design-system',
                   'release-tools', '移动端实验', 'docs-site', 'billing', 'search-infra', 'infra-terraform', '客服工单',
                   'ml-eval', 'growth', 'notifications', 'sandbox', 'legacy-admin', 'playground']


def workspace_row(w, owner, runner):
    """GET /workspaces: the Prisma row, its runner, then withProviderSeed, withRepoHealth, withAntigravityKeys."""
    row = {
        'id': w['id'], 'name': w['name'], 'description': w['description'], 'model': w['model'],
        'appendSystemPrompt': None, 'systemPrompt': None, 'disallowedTools': [], 'providerFallbacks': [],
        'canCreateTasks': True, 'canDelegate': False, 'maxConcurrentTasks': None, 'effort': w['effort'],
        'modelRouting': False, 'modelRoutingProviders': [], 'targetRunnerId': None, 'targetLabels': [],
        'runnerId': runner['id'] if runner else None, 'workDir': f"/srv/orbit/repos/{w['slug']}",
        'repoUrl': f"git@example.test:orbit/{w['slug']}.git", 'env': None, 'codexAccount': None, 'claudeAccount': None,
        'antigravityAccount': None, 'kimiAccount': None, 'cursorAccount': None, 'agentKey': None, 'enabled': w['enabled'],
        'autoInitGit': False, 'enableWorktree': True, 'defaultMergeTarget': None, 'workDirExists': True if runner else None,
        'workDirIsGit': True if runner else None, 'workDirProbedAt': iso(ANCHOR - HOUR) if runner else None,
        'workDirFreeBytes': '412316860416' if runner else None, 'workDirTotalBytes': '1099511627776' if runner else None,
        'ownerId': owner, 'createdAt': iso(w['created']), 'deletedAt': None, 'position': w['position'],
        'runner': {'id': runner['id'], 'name': runner['name'], 'displayName': runner['displayName']} if runner else None,
        'lastEngine': w['provider'], 'lastProvider': w['provider'], 'provider': w['provider'], 'providerBuiltin': True,
        'repoHealth': None, 'repoCleanup': None,
        'antigravityKeyAvailableByRunner': {r: False for r in w['runnerIds']}}
    return row


# What @orbit/shared derivePermissionSemantics answers for the provider/mode pairs these sessions use.
PERMISSIONS = {
    ('claude', 'default'): {'mode': 'default', 'unapproved': 'ask', 'approvalSupport': 'full', 'honored': True},
    ('claude', 'acceptEdits'): {'mode': 'acceptEdits', 'unapproved': 'ask', 'approvalSupport': 'full', 'honored': True},
    ('claude', 'plan'): {'mode': 'plan', 'unapproved': 'ask', 'approvalSupport': 'full', 'honored': True},
    ('codex', 'default'): {'mode': 'default', 'unapproved': 'ask', 'approvalSupport': 'partial', 'honored': True,
                           'note': 'Codex asks before running commands and applying patches; commands it considers safe '
                                   'and read-only run without asking.'},
}
MODELS = {'claude': 'claude-opus-5-5', 'codex': 'gpt-6-astra'}


def session_state(s):
    """withSessionState and deriveSessionCapabilities (apiserver sessions/session-state.ts, @orbit/shared enums.ts)."""
    status, reason = s['status'], (s['endReason'] or '')
    completed, deleted = s['completedAt'], s['deletedAt']
    run = {'PENDING': 'QUEUED', 'RUNNING': 'RUNNING', 'AWAITING_INPUT': 'AWAITING_INPUT', 'SUCCEEDED': 'SUCCEEDED',
           'FAILED': 'FAILED'}.get(status, 'INTERRUPTED' if status == 'INTERRUPTED' and not reason else 'ENDED')
    lifecycle = 'TRASH' if deleted else 'COMPLETED' if completed else 'OPEN'
    filing = {'TRASH': 'TRASH', 'COMPLETED': 'ARCHIVED'}.get(lifecycle, 'OPEN')
    if deleted:
        state = 'DELETED'
    elif completed and status != 'FAILED':
        state = 'COMPLETED'
    elif status in ('CANCELLED', 'INTERRUPTED'):
        state = 'ENDED' if reason == 'orphaned' else 'CANCELLED' if reason in ('completed', 'deleted', 'cancelled', 'task_cancelled') \
            else 'INTERRUPTED' if status == 'INTERRUPTED' and not reason else 'DORMANT'
    else:
        state = {'RUNNING': 'RUNNING', 'AWAITING_INPUT': 'AWAITING_INPUT', 'SUCCEEDED': 'COMPLETED', 'FAILED': 'FAILED',
                 'PENDING': 'QUEUED'}.get(status, 'ENDED')
    terminal = status in ('SUCCEEDED', 'FAILED', 'CANCELLED')
    if lifecycle == 'TRASH':
        blocked = 'TRASHED'
    elif not terminal:
        blocked = 'NOT_TERMINAL'
    elif s['startedAt'] is None:
        blocked = 'NOT_STARTED'
    elif s['numTurns'] > 0 and not s['runtimeSessionId']:
        blocked = 'MISSING_CONTEXT'
    elif not s['runner']:
        blocked = 'NO_RUNNER'
    elif not s['runner']['online']:
        blocked = 'RUNNER_OFFLINE'
    else:
        blocked = None
    can_complete = lifecycle == 'OPEN'
    capabilities = {'canSend': lifecycle != 'TRASH' and (not terminal or blocked is None), 'canResume': blocked is None,
                    'resumeBlockedReason': blocked, 'canComplete': can_complete, 'canArchive': can_complete,
                    'canRestore': lifecycle != 'OPEN'}
    if s.get('capabilityOverride'):
        capabilities.update(s['capabilityOverride'])
    return {'runStatus': status, 'sessionState': state, 'runState': run, 'lifecycleState': lifecycle,
            'filingState': filing}, capabilities


def _runner_ref(s):
    r = s['runner']
    if not r:
        return None
    return {'id': r['id'], 'name': r['name'], 'status': 'ONLINE' if r['online'] else 'OFFLINE',
            'lastHeartbeatAt': iso(ANCHOR - (8 * SECOND if r['online'] else 3 * DAY))}


def session_row(s):
    """GET /sessions?view=…: SessionsService.listRows, withSessionCapabilities, then the owner-decision fields."""
    w = s['workspace']
    running = s['status'] == 'RUNNING'
    row = {
        'id': s['id'], 'status': s['status'], 'title': s['title'], 'createdAt': iso(s['created']),
        'lastTurnAt': iso(s['lastTurn']), 'currentTurnStartedAt': iso(s['lastUser']) if s['status'] in ('RUNNING', 'PENDING') else None,
        'startedAt': iso(s['startedAt']), 'numTurns': s['numTurns'], 'costUsd': s['costUsd'], 'error': s['error'],
        'endReason': s['endReason'], 'cancelRequestedAt': None, 'runtimeSessionId': s['runtimeSessionId'],
        'retryAt': None, 'completedAt': iso(s['completedAt']), 'archivedAt': iso(s['completedAt']),
        'deletedAt': iso(s['deletedAt']), 'sessionKind': 'CONVERSATION', 'source': 'user', 'engine': s['provider'],
        'provider': s['provider'], 'providerBuiltin': True, 'model': MODELS[s['provider']],
        'permissionMode': s['permissionMode'], 'effort': s['effort'], 'fastMode': False,
        'lastAssistantText': clip(s['lastAssistantText']), 'lastToolUse': s['lastToolUse'],
        'lastUserText': clip(s['lastUserText']), 'recapText': clip(s['recapText']), 'recapAt': iso(s['recapAt']),
        'mergeStatus': None, 'sourceState': 'UNBOUND', 'sourceRefusalCode': None, 'sourceRefusalDetail': None,
        'pinnedAt': iso(s['pinnedAt']), 'folderId': s['folderId'], 'shared': False,
        'tags': [dict(t) for t in s['tags']], 'runningBgCount': 0, 'runningBgJobCount': 0, 'runningSubagentCount': 0,
        'engineTurnActive': running, 'engineStartedAt': iso(s['lastUser'] + 2 * SECOND) if running else None,
        'enginePhase': None, 'runClaimedAt': iso(s['lastUser'] + SECOND) if running else None, 'enginePhaseSince': None,
        'workspace': {'id': w['id'], 'name': w['name'], 'model': w['model'], 'effort': w['effort']} if w else None,
        'assignedRunnerId': s['runner']['id'] if s['runner'] else None, 'assignedRunner': _runner_ref(s),
        'taskId': s['taskId'], 'taskTitle': s['taskTitle'], 'projectId': s['coordinates'],
        'projectTitle': s['coordinatesTitle'], 'projectMembership': s['membership'],
        'queuedReason': 'runner_at_capacity' if s['status'] == 'PENDING' else None,
        'queuedActive': 16 if s['status'] == 'PENDING' else None, 'queuedLimit': 16 if s['status'] == 'PENDING' else None}
    state, capabilities = session_state(s)
    row.update(state)
    row['capabilities'] = capabilities
    row['permissionSemantics'] = PERMISSIONS[(s['provider'], s['permissionMode'])]
    row.update(pendingApprovals=0, waitingKind=None, confirmationUnderReview=None, ownerItems=[], awaitingReplyFrom=[],
               owesReplyTo=[])
    return row


# The Session scalars GET /sessions/:id spreads (`...rest`), in schema order, with what an ordinary
# conversation holds in them; the ones the detail reads from the record are filled in session_detail.
DETAIL_COLUMNS = '''id title prompt ownerId creatorId assignedRunnerId workspaceId taskId dispatchOrigin runSource
startsTaskWork contextTaskId resolution snapshotFrozenAt requiredCapabilities executionPinGeneration parentSessionId
rootSessionId spawnDepth batchId batchMaxConcurrent runtimeSessionId importSourceCwd importedAt provider providerBuiltin
engine poolMemberProviderId poolSwitchNotice poolKeyId codexAccount codexAccountPinned claudeAccount claudeAccountPinned
antigravityAccount antigravityAccountPinned kimiAccount kimiAccountPinned cursorAccount cursorAccountPinned
inboxLeaseGeneration coordinatorContextEpoch coordinatorContextAckKey inboxLeaseOwner inboxRequestId inboxRequestTurnId
model usesRuntimeDefaultModel
permissionMode effort fastMode source sessionKind status numTurns costUsd contextTokens contextWindow lastTurnAt
cancelRequestedAt startedAt finishedAt error result endReason lastAssistantText recapText recapAt recapEventSeq
lastToolUse lastUserText runningBgShells runningBgJobs runningSubagents engineTurnActive engineStartedAt enginePhase
runClaimedAt claimRequestId enginePhaseSince sourceState sourceKind sourceCodebaseId sourceRepoUrl sourceRootCommitSha
sourceRef sourceRevisionSha sourceConfigRevision sourceRefAuthority sourceRequiredContains sourceBaseSha sourceResolvedAt
sourceResolvedByRunnerId sourceRefusalCode sourceRefusalDetail branch baseSha changedFiles isolationStatus mergeStatus
mergeError mergeRecovery mergeRecoveryAction mergeRepairTurnEndedAt mergeRequestedAt mergeOperationId
mergeOperationOwner mergedAt mergedSourceSha mergeCheckpointId mergeTarget mergeTargets branchMerged worktreeBranch
branchSha worktreeDirty commitStatus commitError commitResultMessage commitRequestedAt commitOperationId
commitOperationOwner completedAt archivedAt deletedAt pinnedAt folderId retryAt retryAttempts retryClaimedAt createdAt
updatedAt'''.split()
DETAIL_DEFAULTS = {'dispatchOrigin': 'USER', 'runSource': 'MANUAL', 'startsTaskWork': True, 'requiredCapabilities': [],
                   'executionPinGeneration': '0', 'spawnDepth': 0, 'codexAccountPinned': False, 'claudeAccountPinned': False,
                   'antigravityAccountPinned': False, 'kimiAccountPinned': False, 'cursorAccountPinned': False,
                   'coordinatorContextEpoch': 0, 'usesRuntimeDefaultModel': False, 'runningBgShells': [], 'runningBgJobs': [],
                   'runningSubagents': [], 'sourceRequiredContains': [], 'mergeTargets': [], 'retryAttempts': 0,
                   'sourceState': 'UNBOUND', 'sessionKind': 'CONVERSATION', 'source': 'user', 'providerBuiltin': True,
                   'fastMode': False, 'engineTurnActive': False}


def session_detail(s, owner, workspace_full):
    """GET /sessions/:id: the record (SessionsService.get), its workspace and runner, then withSessionCapabilities."""
    row = session_row(s)
    detail = {}
    for column in DETAIL_COLUMNS:
        if column in row:
            detail[column] = row[column]
        else:
            detail[column] = DETAIL_DEFAULTS.get(column)
    detail.update(prompt=s['firstUserText'], ownerId=owner, creatorId=owner,
                  workspaceId=s['workspace']['id'] if s['workspace'] else None,
                  contextTokens=s['contextTokens'], contextWindow=200000 if s['numTurns'] else None,
                  finishedAt=iso(s['lastTurn']) if s['status'] in ('SUCCEEDED', 'FAILED', 'CANCELLED') else None,
                  result=None, recapEventSeq=s['eventCount'] if s['recapText'] else None,
                  isolationStatus='worktree' if s['branch'] else None, branch=s['branch'],
                  worktreeBranch=s['branch'], worktreeDirty=False if s['branch'] else None,
                  baseSha=s['baseSha'], updatedAt=iso(s['lastTurn']))
    detail['workspace'] = dict(workspace_full) if workspace_full else None
    r = s['runner']
    detail['assignedRunner'] = None if not r else {
        'id': r['id'], 'name': r['name'], 'displayName': r['displayName'], 'version': '0.1.236',
        'engines': [{'engine': e, 'installed': True, 'version': v, 'auth': 'yes'} for e, v in r['engines']],
        'status': 'ONLINE' if r['online'] else 'OFFLINE', 'lastHeartbeatAt': iso(ANCHOR - (8 * SECOND if r['online'] else 3 * DAY)),
        'capabilities': ['session-merge-recovery/v1'], 'antigravity': dict(ANTIGRAVITY)}
    detail.update(route=None, poolCodexLogin=None, mergeTarget=None, mergeRepairSession=None,
                  mergeRecoverySupported=bool(r), tags=[dict(t) for t in s['tags']], runningBgJobCount=0,
                  projectId=s['coordinates'], projectTitle=s['coordinatesTitle'], projectIntegrationRef=None,
                  projectMembership=s['membership'], sourceLanding=None, shareToken=None, sharedAt=None)
    state, capabilities = session_state(s)
    detail.update(state)
    detail['capabilities'] = capabilities
    detail['permissionSemantics'] = PERMISSIONS[(s['provider'], s['permissionMode'])]
    return detail


def transcript(s, turns, pairs, *, extra=None):
    """The session's durable events: per turn a user message, an opening reply, `pairs` tool calls and their
    results, a closing reply and turn_end (a RUNNING session's last turn has one more call and no ending).
    Returns the events and each one's time in milliseconds."""
    events, times = [], []
    key = (s['dataset'], s['index'])
    at = s['created'] + 5 * SECOND
    for t in range(turns):
        last = t == turns - 1
        at += number(20 * HOUR, 'gap', t, *key) + 10 * MINUTE
        turn = uuid7(at, 'turn', t, *key)
        user = {'text': (extra or {}).get(('user', t)) or user_text(s['title'], 'turn', t, *key)}
        if (extra or {}).get(('attachments', t)):
            user['attachments'] = extra[('attachments', t)]
        rows = [('user', user)]
        if not (extra or {}).get(('no-intro', t)):
            rows.append(('assistant', {'text': assistant_text(False, t, *key)}))
        calls = pairs(t) if callable(pairs) else pairs
        for p in range(calls + (1 if last and s['status'] == 'RUNNING' else 0)):
            tool, args, output = tool_call(p, t, *key)
            call = 'toolu_' + digest('tool', p, t, *key).hex()[:24]
            rows.append(('tool_use', {'id': call, 'name': tool, 'input': args}))
            rows.append(('tool_result', {'toolUseId': call, 'content': output, 'isError': False}))
        if not (last and s['status'] == 'RUNNING'):
            rows.append(('assistant', {'text': (extra or {}).get(('assistant', t)) or assistant_text(True, t, *key)}))
            rows.append(('turn_end', {'subtype': 'success', 'numTurns': t + 1, 'costUsd': round((t + 1) * 0.0731, 4),
                                      'contextTokens': 18000 + 2500 * t}))
        for kind, payload in rows:
            at += (1 + number(20, 'step', len(events), *key)) * SECOND
            events.append({'seq': len(events) + 1, 'type': kind, 'payload': payload, 'turnId': turn, 'ts': iso(at)})
            times.append(at)
    return events, times


def summarize(s, events, times):
    """The list fields a session's events decide: its last user/assistant text, last tool, turns and times."""
    s['eventCount'] = len(events)
    s['lastTurn'] = times[-1] if times else s['created']
    users = [i for i, e in enumerate(events) if e['type'] == 'user']
    replies = [e for e in events if e['type'] == 'assistant']
    tools = [e for e in events if e['type'] == 'tool_use']
    s['firstUserText'] = events[users[0]]['payload']['text'] if users else ''
    s['lastUserText'] = events[users[-1]]['payload']['text'] if users else None
    s['lastAssistantText'] = replies[-1]['payload']['text'] if replies else None
    s['lastToolUse'] = tools[-1]['payload']['name'] if tools else None
    s['lastUser'] = times[users[-1]] if users else s['created']
    s['numTurns'] = sum(1 for e in events if e['type'] == 'turn_end')
    s['startedAt'] = s['created'] + 2 * SECOND if events else None
    s['runtimeSessionId'] = uuid7(s['created'], 'runtime', s['dataset'], s['index']) if s['numTurns'] else None
    s['costUsd'] = round(s['numTurns'] * 0.0731, 4)
    s['contextTokens'] = 18000 + 2500 * (s['numTurns'] - 1) if s['numTurns'] else None



# ----------------------------------------------------------------------------------------- tasks, projects

TASK_LABELS = ['android', 'ios', 'web', 'release', 'bug', 'perf', 'docs', 'infra', '测试', 'Sprint, one']
LIST_TITLES = ['Release checklist', 'Bug triage', 'Perf follow-ups', '文档整理', 'Infra chores', 'Design QA',
               'Customer asks', 'Spikes']
PROJECT_TITLES = ['Android client parity', 'Wiki search ranking', 'Runner link rollout', '推送通道改造',
                  'Session folders', 'Billing cleanup', 'Docs site refresh', 'Landing reliability', '移动端性能',
                  'Watch notifications']


def model_hint_options():
    return [{'level': 'S', 'provider': 'claude', 'model': 'claude-sonnet-5-5', 'label': 'Sonnet 5.5', 'effort': 'low'},
            {'level': 'M', 'provider': 'claude', 'model': 'claude-sonnet-5-5', 'label': 'Sonnet 5.5', 'effort': 'medium'},
            {'level': 'L', 'provider': 'claude', 'model': 'claude-opus-5-5', 'label': 'Opus 5.5', 'effort': 'high'},
            {'level': 'XL', 'provider': 'claude', 'model': 'claude-opus-5-5', 'label': 'Opus 5.5', 'effort': 'max'}]


NOT_APPLICABLE = {'state': 'NOT_APPLICABLE', 'since': None, 'handler': None, 'openItemId': None, 'jobId': None,
                  'checksRunningForMs': None, 'landTask': None, 'mainBranch': 'main'}


class Work:
    """Task lists, projects and tasks of a World (mixed into World)."""

    def add_task_lists(self, count):
        self.lists = []
        for i in range(count):
            created = self.created + (20 + 11 * i) * DAY
            self.lists.append({'id': uuid7(created, 'list', self.dataset, i), 'index': i, 'title': LIST_TITLES[i % len(LIST_TITLES)],
                               'created': created, 'paused': i == 1, 'maxConcurrent': 2 if i % 2 == 0 else None,
                               'instructions': f'Work through the {LIST_TITLES[i % len(LIST_TITLES)].lower()} one task at a time.'})

    def add_projects(self, count, done=0, cancelled=0):
        self.projects = []
        open_sessions = [s for s in self.sessions if s['view'] == 'open' and s['workspace'] and not s['taskId']]
        for i in range(count):
            created = ANCHOR - (150 - i * (120 // max(1, count))) * DAY
            status = 'DONE' if i < done else 'CANCELLED' if i < done + cancelled else 'OPEN'
            title = PROJECT_TITLES[i % len(PROJECT_TITLES)] + ('' if i < len(PROJECT_TITLES) else f' {i // len(PROJECT_TITLES) + 1}')
            p = {'id': uuid7(created, 'project', self.dataset, i), 'index': i, 'title': title, 'status': status,
                 'created': created, 'started': created + DAY if i % 7 != 3 else None,
                 'done': created + 60 * DAY if status == 'DONE' else None, 'coordinator': None,
                 'goal': f'{title}: deliver it end to end with tests and docs.',
                 'criteria': [f'{title} — criterion {k + 1}: the behaviour is covered by a passing test.' for k in range(1 + i % 3)]}
            # An open project is coordinated from one of the open conversations (its coordinator session).
            if status == 'OPEN' and open_sessions:
                s = open_sessions.pop(number(len(open_sessions), 'coordinator', self.dataset, i))
                s['coordinates'], s['coordinatesTitle'] = p['id'], title
                s['membership'] = jsonb({'projectId': p['id'], 'projectTitle': title, 'projectStatus': status, 'role': 'COORDINATOR'})
                p['coordinator'] = s
            self.projects.append(p)

    def add_tasks(self, count, *, keywords=None, ties=()):
        """`keywords` plants exact title words: {word: how many tasks carry it} (DS2's fixed search words).
        `ties` lists positions in page order (newest first, from 0) that get the creation time of the first of
        them, so a page boundary falls inside a run of equal createdAt values (the cursor's id tie-break)."""
        self.tasks = []
        planted = []
        for word, n in (keywords or {}).items():
            planted += [word] * n
        runs = [s for s in self.sessions if not s['coordinates'] and s['workspace']]
        times = [ANCHOR - 200 * DAY + number(195 * DAY, 'created', self.dataset, 'task', i) for i in range(count)]
        order = sorted(range(count), key=lambda i: times[i], reverse=True)
        if ties:
            for position in ties:
                times[order[position]] = times[order[ties[0]]]
        for i in range(count):
            key = (self.dataset, 'task', i)
            created = times[i]
            status = choose(['OPEN'] * 35 + ['IN_PROGRESS'] * 10 + ['DONE'] * 40 + ['FAILED'] * 8 + ['CANCELLED'] * 7, 'status', *key)
            assignee = self.workspaces[number(len(self.workspaces), 'assignee', *key)] if self.workspaces else None
            project = self.projects[number(len(self.projects), 'project', *key)] if self.projects and chance(60, 'in-project', *key) else None
            task_list = self.lists[number(len(self.lists), 'list', *key)] if self.lists and not project and chance(50, 'in-list', *key) else None
            title = title_of('task', *key)
            if i < len(planted):
                title = f'{title} · {planted[i]}'
            labels = sorted({choose(TASK_LABELS, 'label', k, *key) for k in range(number(3, 'labels', *key))})
            criterion = choose(['EVIDENCE_JUDGMENT'] * 7 + ['EXECUTABLE'] * 2 + ['OWNER_CONFIRMED'], 'criterion', *key)
            t = {'id': uuid7(created, 'task', *key), 'index': i, 'title': title, 'status': status, 'created': created,
                 'updated': created + number(5 * DAY, 'updated', *key), 'assignee': assignee, 'project': project,
                 'list': task_list, 'labels': labels, 'criterion': criterion, 'priority': choose([0] * 8 + [1, 3], 'prio', *key),
                 'creatorType': choose(['USER', 'AGENT'], 'creator', *key), 'sessions': [], 'dependsOn': [],
                 'modelHint': choose(['S', 'M', 'L', 'XL'], 'hint', *key), 'description': None}
            t['description'] = (f'## {title}\n\n{choose(EN_DETAILS, "desc", *key)}\n\n- [ ] {choose(EN_OBJECTS, "step1", *key)}\n'
                                f'- [ ] {choose(EN_OBJECTS, "step2", *key)}\n')
            if status in ('IN_PROGRESS', 'DONE', 'FAILED') and runs and chance(45, 'has-run', *key):
                s = runs.pop(number(len(runs), 'run', *key))
                s['taskId'], s['taskTitle'] = t['id'], title
                if project:
                    s['membership'] = jsonb({'projectId': project['id'], 'projectTitle': project['title'],
                                             'projectStatus': project['status'], 'role': 'TASK'})
                t['sessions'].append(s)
            self.tasks.append(t)
        # A few prerequisites inside each project: a later task depends on an earlier one.
        by_project = {}
        for t in self.tasks:
            if t['project']:
                by_project.setdefault(t['project']['id'], []).append(t)
        for rows in by_project.values():
            rows.sort(key=lambda t: t['created'])
            for a, b in zip(rows, rows[1:]):
                if chance(30, 'dep', a['id'], b['id']):
                    b['dependsOn'].append(a)

    # Derived task state ------------------------------------------------------------------------------

    def run_state(self, t):
        live = [s for s in t['sessions'] if s['status'] in ('RUNNING', 'PENDING')]
        running = any(s['status'] == 'RUNNING' for s in live)
        queued = not running and any(s['status'] == 'PENDING' for s in live)
        return running, queued

    def dependency_state(self, t):
        if not t['dependsOn']:
            return 'NONE'
        if any(d['status'] in ('FAILED', 'CANCELLED') for d in t['dependsOn']):
            return 'BLOCKED_FAILED'
        return 'READY' if all(d['status'] == 'DONE' for d in t['dependsOn']) else 'BLOCKED'

    def runnable(self, t):
        running, queued = self.run_state(t)
        w = t['assignee']
        return (t['status'] != 'DONE' and bool(w) and bool(w['runner']) and w['enabled'] and not running and not queued
                and self.dependency_state(t) in ('NONE', 'READY'))

    def task_row(self, t):
        """A row of GET /tasks/page (TasksService TASK_LIST_SELECT and its overlays)."""
        running, queued = self.run_state(t)
        w = t['assignee']
        deps = self.dependency_state(t)
        r = w['runner'] if w else None
        live = [s for s in t['sessions'] if s['status'] == 'RUNNING']
        return {
            'id': t['id'], 'title': t['title'], 'status': t['status'], 'ownerId': self.owner, 'creatorType': t['creatorType'],
            'creatorId': self.owner if t['creatorType'] == 'USER' else (w['id'] if w else self.owner),
            'assigneeId': w['id'] if w else None, 'dueDate': None, 'runAt': None, 'createdAt': iso(t['created']),
            'updatedAt': iso(t['updated']), 'listId': t['list']['id'] if t['list'] else None,
            'projectId': t['project']['id'] if t['project'] else None, 'fixesOpenItemId': None, 'parentTaskId': None,
            'acceptanceCriteria': 'The change is covered by a passing test.',
            'acceptanceCommand': 'npm test' if t['criterion'] == 'EXECUTABLE' else None,
            'acceptanceExpectedExitCode': 0 if t['criterion'] == 'EXECUTABLE' else None, 'acceptanceTimeoutSeconds': None,
            'completionCriterion': t['criterion'], 'completionCriterionOverrideReason': None, 'labels': t['labels'],
            'creatorSessionId': None, 'autoRunWhenReady': bool(t['project']), 'priority': t['priority'], 'engine': None,
            'provider': None, 'model': None, 'modelHint': t['modelHint'], 'modelHintReason': None,
            'completionPolicy': 'MANUAL', 'verdict': None, 'verifiesTaskId': None, 'supersededByTaskId': None,
            'supersededAt': None, 'terminalReason': None, 'dispatchRefusal': None,
            'assignee': {'id': w['id'], 'name': w['name'], 'model': w['model'], 'runnerId': r['id'] if r else None,
                         'runner': {'id': r['id'], 'name': r['name'], 'displayName': r['displayName'],
                                    'maxConcurrent': r['maxConcurrent']} if r else None} if w else None,
            '_count': {'comments': number(4, 'comments', t['id'])},
            'running': running, 'queued': queued, 'runReason': 'TURN' if running else None, 'runStalled': False,
            'runningSince': iso(live[0]['lastUser']) if live else None, 'dependencyState': deps,
            'blocked': deps not in ('NONE', 'READY'), 'runnable': self.runnable(t), 'awaitingOwnerConfirmation': False,
            'confirmationUnderReview': False}

    def task_detail(self, t):
        """GET /tasks/:id (TasksService.get)."""
        row = self.task_row(t)
        w = t['assignee']
        deps = self.dependency_state(t)
        detail = {k: row[k] for k in ('id', 'title')}
        detail.update(description=t['description'], status=t['status'], ownerId=self.owner, creatorType=t['creatorType'],
                      creatorId=row['creatorId'], creatorSessionId=None, assigneeId=row['assigneeId'], listId=row['listId'],
                      projectId=row['projectId'], fixesOpenItemId=None,
                      discoveredFromProjectId=row['projectId'], triggerEvent=None, sourceTaskId=None, sourceSessionId=None,
                      parentTaskId=None, acceptanceCriteria=row['acceptanceCriteria'], acceptanceCommand=row['acceptanceCommand'],
                      acceptanceExpectedExitCode=row['acceptanceExpectedExitCode'], acceptanceTimeoutSeconds=None,
                      completionCriterion=t['criterion'], completionFenceRevision=1, completionCriterionOverrideReason=None,
                      ownerConfirmationReason=None, ownerConfirmationReasonNote=None, criterionDefinitionId=None,
                      criterionRevision=None, labels=t['labels'], dueDate=None, runAt=None, provider=None, engine=None,
                      model=None, modelHint=t['modelHint'], modelHintReason=None, autoRunWhenReady=row['autoRunWhenReady'],
                      dispatchHold=False, priority=t['priority'], dispatchAttempt='0', requiredCapabilities=[],
                      isForeman=False, completionPolicy='MANUAL', verdict=None, verdictRevision='0', verifiesTaskId=None,
                      supersededByTaskId=None, supersededAt=None, terminalReason=None, idempotencyKey=None,
                      scopeRevision=1, attemptGeneration='0', progressState='CONVERGING',
                      convergenceCounters={'transientRetries': 0, 'sameActionRepeats': 0, 'attemptsOnRevision': 0,
                                           'verificationRounds': 0, 'sameFingerprintRepeats': 0,
                                           'scopeExpansionRequests': 0, 'attemptsWithoutProgress': 0,
                                           'decisionsWithoutProgress': 0, 'repairsWithoutSeverityDrop': 0},
                      lastProgressAt=None, knownGoodSha=None, pinnedRevision=None, codeless=False, codelessReason=None,
                      dispatchRefusal=None, createdAt=row['createdAt'], updatedAt=row['updatedAt'],
                      assignee={'id': w['id'], 'name': w['name'], 'model': w['model']} if w else None,
                      project={'id': t['project']['id'], 'title': t['project']['title'], 'status': t['project']['status']}
                      if t['project'] else None, comments=[], attachments=[])
        sessions = []
        for s in sorted(t['sessions'], key=lambda s: -s['created']):
            state, _ = session_state(s)
            sessions.append({'id': s['id'], 'title': s['title'], 'status': s['status'], 'endReason': s['endReason'],
                             'completedAt': iso(s['completedAt']), 'archivedAt': iso(s['completedAt']),
                             'deletedAt': iso(s['deletedAt']), 'createdAt': iso(s['created']), 'model': MODELS[s['provider']],
                             'effort': s['effort'], 'workspace': {'name': s['workspace']['name']} if s['workspace'] else None,
                             **state, 'route': None})
        edges = [{'id': uuid7(t['created'], 'edge', t['id'], d['id']), 'taskId': t['id'], 'dependsOnTaskId': d['id'],
                  'createdAt': iso(t['created']), 'dependsOnTask': {'id': d['id'], 'title': d['title'], 'status': d['status']}}
                 for d in t['dependsOn']]
        dependents = [o for o in self.tasks if t in o['dependsOn']]
        detail.update(sessions=sessions, creatorSession=None, dependsOn=edges,
                      dependedOnBy=[{'id': uuid7(o['created'], 'edge', o['id'], t['id']), 'taskId': o['id'],
                                     'dependsOnTaskId': t['id'], 'createdAt': iso(o['created']),
                                     'task': {'id': o['id'], 'title': o['title'], 'status': o['status']}} for o in dependents],
                      supersedes=[], dependencyState=deps, blocked=deps not in ('NONE', 'READY'), autoRunSkipped=None,
                      completionCriterionChange=None, verificationState=None, verifier=None,
                      progress={'taskId': t['id'], 'lifecycleEpoch': 0, 'epochStartedAt': row['createdAt'], 'phase': None,
                                'current': None, 'total': None, 'message': None, 'revision': 0, 'lastProgressAt': None,
                                'updatedAt': None},
                      modelHintOptions=model_hint_options(), integration=dict(NOT_APPLICABLE),
                      outcome=t['status'], supersededByTaskIdAbsentReason='NOT_SUPERSEDED',
                      supersedesEmptyReason='SUPERSEDES_NOTHING', successorChain=[], successorChainTruncated=False)
        return detail

    def list_row(self, l):
        """A row of GET /task-lists (TaskListsService.list)."""
        tasks = [t for t in self.tasks if t['list'] is l]
        return {'id': l['id'], 'title': l['title'], 'ownerId': self.owner, 'createdAt': iso(l['created']),
                'updatedAt': iso(l['created'] + DAY), 'paused': l['paused'], 'maxConcurrent': l['maxConcurrent'],
                'foremanWorkspaceId': None, 'foremanStallMinutes': None, 'verifyOnDone': False, 'ownerSessionId': None,
                '_count': {'tasks': len(tasks)}, 'runningTasks': sum(1 for t in tasks if self.run_state(t)[0]),
                'tasksOutsideProjects': len(tasks), 'completed': sum(1 for t in tasks if t['status'] == 'DONE')}

    def list_document(self, l):
        """GET /task-lists/:id?tasks=none: the TaskList row as stored."""
        tasks = [t for t in self.tasks if t['list'] is l]
        return {'id': l['id'], 'title': l['title'], 'ownerId': self.owner, 'createdAt': iso(l['created']),
                'updatedAt': iso(l['created'] + DAY), 'instructions': l['instructions'], 'paused': l['paused'],
                'pauseEpoch': 1 if l['paused'] else 0, 'pauseAppliedEpoch': 1 if l['paused'] else 0,
                'maxConcurrent': l['maxConcurrent'], 'foremanWorkspaceId': None, 'foremanStallMinutes': None,
                'verifyOnDone': False, 'ownerSessionId': None, 'taskCount': len(tasks),
                'taskDoneCount': sum(1 for t in tasks if t['status'] == 'DONE'), 'hidden': False}

    # Projects ----------------------------------------------------------------------------------------

    def project_tasks(self, p):
        return [t for t in self.tasks if t['project'] is p]

    def buckets(self, p):
        out = {'running': 0, 'ready': 0, 'blocked': 0, 'awaitingVerification': 0, 'done': 0, 'failed': 0, 'cancelled': 0}
        for t in self.project_tasks(p):
            out[self.work_state(t).lower().replace('awaiting_verification', 'awaitingVerification')] += 1
        return out

    def work_state(self, t):
        if t['status'] == 'DONE':
            return 'DONE'
        if t['status'] == 'FAILED':
            return 'FAILED'
        if t['status'] == 'CANCELLED':
            return 'CANCELLED'
        if self.run_state(t)[0]:
            return 'RUNNING'
        return 'READY' if self.dependency_state(t) in ('NONE', 'READY') else 'BLOCKED'

    def attention(self, p):
        return {'userBlockers': 0, 'coordinatorBlockers': 0, 'systemBlockers': 0, 'maxSeverity': None,
                'attentionSinceAt': None, 'nextCheckAt': None, 'ownerItems': [], 'coordinatorItems': None,
                'startRequest': None, 'doneRequest': None}

    def last_activity(self, p):
        times = [t['updated'] for t in self.project_tasks(p)] + ([p['coordinator']['lastTurn']] if p['coordinator'] else [])
        return iso(max(times)) if times else None

    def project_integration_brief(self, p):
        return {'line': 'PROJECT_BRANCH', 'ref': f"project/{base62(p['id'])}", 'activeJobCount': 0, 'inFlight': None}

    def project_row(self, p):
        """A row of GET /projects (ProjectsService.list)."""
        c = p['coordinator']
        return {'id': p['id'], 'title': p['title'], 'status': p['status'], 'doneBy': 'OWNER' if p['done'] else None,
                'doneAt': iso(p['done']), 'acceptedGaps': [], 'goal': p['goal'], 'createdAt': iso(p['created']),
                'updatedAt': iso(p['created'] + 2 * DAY), 'coordinatorAgentId': c['workspace']['id'] if c else None,
                'coordinatorGeneration': '1' if c else '0', '_count': {'tasks': len(self.project_tasks(p))},
                'buckets': self.buckets(p), 'lastActivityAt': self.last_activity(p), 'attention': self.attention(p),
                'integration': self.project_integration_brief(p), 'mainBranch': 'main',
                'coordinatorActivity': {'working': bool(c and c['status'] == 'RUNNING'), 'lastTurnAt': iso(c['lastTurn'])} if c else None}

    def sidebar_row(self, p):
        """A row of GET /projects/sidebar (OPEN projects only)."""
        tasks = self.project_tasks(p)
        c = p['coordinator']
        return {'id': p['id'], 'title': p['title'], 'status': p['status'], 'createdAt': iso(p['created']),
                'startedAt': iso(p['started']), 'taskCounts': {'done': sum(1 for t in tasks if t['status'] == 'DONE'),
                                                               'failed': sum(1 for t in tasks if t['status'] == 'FAILED'),
                                                               'total': len(tasks)},
                'buckets': {'running': self.buckets(p)['running']}, 'lastActivityAt': self.last_activity(p),
                'attention': self.attention(p),
                'coordinatorActivity': {'working': bool(c and c['status'] == 'RUNNING'), 'lastTurnAt': iso(c['lastTurn'])} if c else None,
                'integration': self.project_integration_brief(p), 'mainBranch': 'main'}

    def integration_settings(self, p):
        return {'line': 'PROJECT_BRANCH', 'lineAbsentReason': None, 'ref': f"project/{base62(p['id'])}", 'upstreamRef': 'main',
                'upstreamChosenAt': None, 'source': 'EXPLICIT', 'locked': True, 'startedAt': iso(p['started']),
                'mergeCheckCommand': 'npm test', 'mergeCheckCommandAbsentReason': None, 'mergeCheckTimeoutSeconds': None,
                'escalationSeconds': 7200, 'lastMainBranch': None}

    def project_document(self, p):
        """GET /projects/:id (ProjectsService.get)."""
        c = p['coordinator']
        tasks = self.project_tasks(p)
        by_status = {}
        for t in tasks:
            by_status[t['status']] = by_status.get(t['status'], 0) + 1
        items, derived = [], []
        for k, text in enumerate(p['criteria']):
            cid = uuid7(p['created'], 'criterion', p['id'], k)
            met = p['status'] == 'DONE'
            items.append({'id': cid, 'ordinal': k + 1, 'text': text, 'verificationMethod': 'Run the tests and read the report.',
                          'completionCriterionOverrideReason': None, 'key': base62(cid), 'revision': 1,
                          'contentHash': digest('criterion-hash', cid).hex(), 'semanticRevision': 1,
                          'semanticHash': digest('criterion-semantic', cid).hex(), 'satisfied': met,
                          'unmet': [] if met else [{'clause': 'NO_WORK_SERVES_IT', 'heldUpBy': []}],
                          'landing': 'LANDED' if met else 'UNKNOWN', 'independence': 'INDEPENDENT', 'conflicts': [],
                          'remedy': None})
            derived.append({'definitionId': cid, 'satisfied': met, 'landing': 'LANDED' if met else 'UNKNOWN',
                            'independence': 'INDEPENDENT', 'conflicts': [], 'remedy': None,
                            'landingReason': None if met else 'NO_RECEIPT',
                            'withheld': [] if met else ['CRITERION_UNSATISFIED', 'CRITERION_UNLANDED']})
        met = sum(1 for d in derived if d['satisfied'])
        withheld = (['CRITERION_UNSATISFIED', 'CRITERION_UNLANDED'] if met < len(derived) else []) + ['STANDARD_SET_UNCONFIRMED']
        return {'id': p['id'], 'title': p['title'], 'ownerId': self.owner, 'goal': p['goal'],
                'instructions': 'Keep each task small and land it with its tests.', 'status': p['status'],
                'doneBy': 'OWNER' if p['done'] else None, 'doneAt': iso(p['done']), 'doneCriteriaDigest': None,
                'acceptedGaps': [], 'coordinatorSessionId': c['id'] if c else None,
                'coordinatorWorkspaceId': c['workspace']['id'] if c else None, 'coordinatorEnabled': bool(c),
                'maxConcurrentTasks': 3, 'sessionBudgetPerDay': None, 'configRevision': '1', 'convergenceThresholds': None,
                'attemptBudget': None, 'unboundedAuthorizedBy': None, 'exceptionEscalationSeconds': 7200,
                'startedAt': iso(p['started']), 'pausedAt': None, 'pausedReason': None, 'createdAt': iso(p['created']),
                'updatedAt': iso(p['created'] + 2 * DAY), 'coordinatorAgentId': c['workspace']['id'] if c else None,
                'coordinatorGeneration': '1' if c else '0', '_count': {'tasks': len(tasks)}, 'tasksByStatus': by_status,
                'acceptanceCriteriaItems': items, 'blockers': {'open': [], 'resolved': [], 'resolvedCount': 0},
                'integration': self.integration_settings(p),
                'derivedDone': {'status': p['status'], 'done': p['status'] == 'DONE', 'withheld': withheld,
                                'criteria': derived, 'confirmation': 'UNCONFIRMED',
                                'counts': {'criteria': len(derived), 'met': met, 'landed': met, 'onMain': met,
                                           'byReason': {'IN_FLIGHT': 0, 'ON_PROJECT_BRANCH': 0, 'NOTHING_TO_LAND': 0,
                                                        'NO_RECEIPT': len(derived) - met, 'CODELESS': 0}}}}

    def project_task_row(self, t):
        """A row of GET /projects/:id/tasks/page (ProjectsService.taskPage)."""
        deps = self.dependency_state(t)
        deps = 'READY' if deps == 'NONE' else deps
        running, _ = self.run_state(t)
        dependents = sum(1 for o in self.tasks if t in o['dependsOn'])
        return {'id': t['id'], 'title': t['title'], 'status': t['status'], 'parentTaskId': None,
                'acceptanceCriteria': 'The change is covered by a passing test.', 'createdAt': iso(t['created']),
                'updatedAt': iso(t['updated']), 'dueDate': None, 'runAt': None, 'completionCriterion': t['criterion'],
                'completionPolicy': 'MANUAL', 'verdict': None, 'verifiesTaskId': None, 'autoRunWhenReady': True,
                'assignee': {'id': t['assignee']['id'], 'name': t['assignee']['name']} if t['assignee'] else None,
                'workState': self.work_state(t), 'verificationState': None, 'runReason': 'TURN' if running else None,
                'runStalled': False, 'integration': dict(NOT_APPLICABLE), 'childCount': 0,
                'unmetCount': sum(1 for d in t['dependsOn'] if d['status'] != 'DONE'), 'blocksCount': dependents,
                'topoLevel': len(t['dependsOn']), 'dependencyState': deps, 'landingWaitCount': 0, 'blocked': deps != 'READY'}

    def project_open_items(self, p):
        return {'needsYou': [], 'withCoordinator': [], 'startRequest': None, 'doneRequest': None, 'settled': [],
                'closedQuestions': [], 'mainBranch': 'main'}

    def project_integration(self, p):
        """GET /projects/:id/integration: the settings plus the line's state (nothing landed yet)."""
        return {**self.integration_settings(p), 'repository': None, 'branches': None, 'commitsAheadOfUpstream': None,
                'commitsAheadOfUpstreamAbsentReason': 'NO_LANDING_YET', 'lastUpstreamSyncAt': None,
                'lastUpstreamSyncAbsentReason': 'NEVER_SYNCED', 'integratingCount': 0, 'queuedCount': 0,
                'mergeCheckOnTip': 'UNKNOWN', 'landTasks': [], 'inFlight': None, 'inFlightJobs': []}

    # Side reads of a task's and a project's pages ----------------------------------------------------

    def owner_confirmation(self, t):
        """GET /tasks/:id/owner-confirmation for a task with no open request."""
        return {'taskId': t['id'], 'title': t['title'], 'status': t['status'],
                'projectId': t['project']['id'] if t['project'] else None, 'completionCriterion': t['criterion'],
                'acceptanceCriteria': 'The change is covered by a passing test.', 'waiting': None, 'ifConfirmed': None,
                'decisions': [], 'reviewerReturns': []}

    def attribution(self, t):
        p = t['project']
        return {'taskId': t['id'],
                'owning': {'projectId': p['id'], 'title': p['title'], 'status': p['status']} if p else None,
                'owningAbsentReason': None if p else 'FILED_UNDER_NO_PROJECT',
                'discovery': {'project': None, 'triggerEvent': None, 'task': None, 'session': None, 'recorded': False,
                              'absentReason': 'NO_DISCOVERY_RECORDED', 'authority': 'EVIDENCE_ONLY'},
                'crossing': None, 'crossingAbsentReason': 'NO_CROSSING_DECLARED', 'blocker': None,
                'blockerAbsentReason': 'NOTHING_BLOCKING_ATTRIBUTION'}

    def graph_node(self, t, depth):
        running, queued = self.run_state(t)
        live = [s for s in t['sessions'] if s['status'] == 'RUNNING']
        return {'id': t['id'], 'title': t['title'], 'status': t['status'], 'autoRunWhenReady': bool(t['project']),
                'depth': depth, 'running': running, 'queued': queued, 'runReason': 'TURN' if running else None,
                'runStalled': False, 'runningSince': iso(live[0]['lastUser']) if live else None,
                'prerequisiteCount': len(t['dependsOn']), 'dependentCount': sum(1 for o in self.tasks if t in o['dependsOn']),
                'dependencyState': self.dependency_state(t)}

    def task_graph(self, t):
        """GET /tasks/:id/dependency-graph?direction=both&maxNodes=500&pairUnary=true: the task's direct neighbours."""
        up = list(t['dependsOn'])
        down = [o for o in self.tasks if t in o['dependsOn']]
        nodes = [self.graph_node(t, 0)] + [self.graph_node(x, 1) for x in up + down]
        edges = [{'sourceTaskId': x['id'], 'targetTaskId': t['id']} for x in up] + \
                [{'sourceTaskId': t['id'], 'targetTaskId': x['id']} for x in down]
        everyone = up + down
        return {'focusTaskId': t['id'], 'direction': 'both', 'pairUnary': True, 'nodes': nodes, 'edges': edges,
                'counts': {'upstream': len(up), 'downstream': len(down), 'connected': len(everyone), 'lateral': 0,
                           'total': len(nodes), 'done': sum(1 for x in everyone if x['status'] == 'DONE'),
                           'remaining': sum(1 for x in everyone if x['status'] not in ('DONE', 'CANCELLED')),
                           'failed': sum(1 for x in everyone if x['status'] == 'FAILED')},
                'maxDepth': 1 if everyone else 0, 'truncated': False, 'truncationReasons': [], 'collapsedGroups': [],
                'limits': {'maxDepth': 8, 'maxNodes': 500, 'maxEdges': 2000}}

    def criteria_material(self, p):
        rows = []
        for k, text in enumerate(p['criteria']):
            cid = uuid7(p['created'], 'criterion', p['id'], k)
            rows.append((cid, 1, digest('criterion-hash', cid).hex()))
        rows.sort()
        joined = ','.join(f'{cid}:{rev}:{content}' for cid, rev, content in rows)
        return hashlib.sha256(joined.encode()).hexdigest(), rows

    def acceptance_confirmation(self, p):
        """GET /projects/:id/acceptance/confirmation: the criteria as stated, never confirmed."""
        seal, rows = self.criteria_material(p)
        return {'state': 'UNCONFIRMED', 'confirmed': False,
                'currentVersion': {'digest': seal, 'material': [{'definitionId': cid, 'revision': rev, 'contentHash': content}
                                                                for cid, rev, content in rows]},
                'confirmation': None, 'changesSinceConfirmed': None, 'changesSinceConfirmedAbsentReason': 'NEVER_CONFIRMED'}

    def criteria_decisions(self, p):
        return {'readAt': iso(ANCHOR), 'projectId': p['id'], 'count': 0, 'oldestAgeSeconds': None, 'decidableCount': 0,
                'pending': [], 'settled': []}

    def panorama(self, p):
        tasks = self.project_tasks(p)
        edges = sum(len(t['dependsOn']) for t in tasks)
        depth = max([len(t['dependsOn']) for t in tasks] or [0])
        return {'buckets': self.buckets(p),
                'shape': {'taskCount': len(tasks), 'edgeCount': edges, 'ratio': round(edges / len(tasks), 4) if tasks else 0,
                          'maxDepth': depth, 'form': 'chain' if edges <= len(tasks) else 'mesh'}}

    def ready(self, p, limit=5):
        tasks = self.project_tasks(p)
        ready = [t for t in tasks if self.work_state(t) == 'READY' and t['status'] in ('OPEN', 'IN_PROGRESS')]
        running = [t for t in tasks if self.run_state(t)[0]]
        queued = [t for t in tasks if self.run_state(t)[1]]
        items = [{'taskId': t['id'], 'title': t['title'], 'status': t['status'], 'runState': 'READY', 'sessionId': None,
                  'runReason': None, 'runStalled': False, 'pausedList': None,
                  'downstreamBlocked': sum(1 for o in tasks if t in o['dependsOn'])} for t in ready[:limit]]
        return {'readyCount': len(ready), 'manualReady': None, 'queuedCount': len(queued), 'runningCount': len(running),
                'pausedCount': 0, 'waitingForLanding': 0, 'items': items, 'impactTruncated': None}

    def coordinator_status(self, p):
        """GET /projects/:id/coordinator/status: LIVE when the project has a coordinator conversation, else NEVER_OPENED."""
        c = p['coordinator']
        tasks = self.project_tasks(p)
        borrow = next((t['assignee'] for t in tasks if t['assignee']), None)
        if c:
            state, _ = session_state(c)
            done = c['status'] in ('SUCCEEDED', 'FAILED', 'CANCELLED')
            session = {'id': c['id'], 'title': c['title'], 'runStatus': c['status'], 'runState': state['runState'],
                       'lifecycleState': state['lifecycleState'], 'filingState': state['filingState'],
                       'endReason': c['endReason'], 'endReasonAbsentReason': None if c['endReason'] else 'SESSION_NOT_ENDED',
                       'startedAt': iso(c['startedAt']), 'startedAtAbsentReason': None if c['startedAt'] else 'SESSION_NEVER_STARTED',
                       'finishedAt': iso(c['lastTurn']) if done else None,
                       'finishedAtAbsentReason': None if done else 'SESSION_STILL_RUNNING',
                       'completedAt': iso(c['completedAt']), 'completedAtAbsentReason': None if c['completedAt'] else 'SESSION_NOT_COMPLETED',
                       'deletedAt': None, 'deletedAtAbsentReason': 'SESSION_NOT_TRASHED', 'lastTurnAt': iso(c['lastTurn']),
                       'lastTurnAtAbsentReason': None, 'engineTurnActive': c['status'] == 'RUNNING', 'pendingApprovals': 0}
            w = c['workspace']
            coordination = {'sessionId': c['id'], 'sessionIdAbsentReason': None, 'session': session, 'sessionAbsentReason': None,
                            'coordinatorGeneration': '1', 'workspaceId': w['id'], 'workspaceIdAbsentReason': None,
                            'workspaceName': w['name'], 'workspaceNameAbsentReason': None, 'agentId': w['id'],
                            'agentIdAbsentReason': None, 'agentName': w['name'], 'agentNameAbsentReason': None,
                            'wakeups': {'state': 'NONE', 'at': None},
                            'fuse': {'selfStartedToday': 0, 'limit': 40, 'paused': False, 'episodeId': None}}
            openability = {'canOpen': True, 'willCreate': False, 'refusalCode': None, 'refusalDetail': None,
                           'refusalCodeAbsentReason': 'NOTHING_REFUSES', 'requiredAction': None,
                           'requiredActionAbsentReason': 'NOTHING_REFUSES',
                           'landing': {'workspaceId': None, 'workspaceIdAbsentReason': 'COORDINATOR_ALREADY_LIVE', 'workspaceName': None,
                                       'workspaceNameAbsentReason': 'COORDINATOR_ALREADY_LIVE', 'agentId': None, 'agentName': None,
                                       'fixed': False}}
            return {'projectId': p['id'], 'readAt': iso(ANCHOR), 'state': 'LIVE', 'coordination': coordination,
                    'openability': openability}
        coordination = {'sessionId': None, 'sessionIdAbsentReason': 'COORDINATOR_NEVER_OPENED', 'session': None,
                        'sessionAbsentReason': 'COORDINATOR_NEVER_OPENED', 'coordinatorGeneration': '0', 'workspaceId': None,
                        'workspaceIdAbsentReason': 'NO_COORDINATION_WORKSPACE', 'workspaceName': None,
                        'workspaceNameAbsentReason': 'NO_COORDINATION_WORKSPACE', 'agentId': None,
                        'agentIdAbsentReason': 'NO_COORDINATOR_AGENT', 'agentName': None, 'agentNameAbsentReason': 'NO_COORDINATOR_AGENT',
                        'wakeups': {'state': 'NONE', 'at': None},
                        'fuse': {'selfStartedToday': 0, 'limit': 40, 'paused': False, 'episodeId': None}}
        if borrow:
            openability = {'canOpen': True, 'willCreate': True, 'refusalCode': None, 'refusalDetail': None,
                           'refusalCodeAbsentReason': 'NOTHING_REFUSES', 'requiredAction': None,
                           'requiredActionAbsentReason': 'NOTHING_REFUSES',
                           'landing': {'workspaceId': borrow['id'], 'workspaceIdAbsentReason': None, 'workspaceName': borrow['name'],
                                       'workspaceNameAbsentReason': None, 'agentId': borrow['id'], 'agentName': borrow['name'],
                                       'fixed': False}}
        else:
            openability = {'canOpen': False, 'willCreate': True, 'refusalCode': 'NO_LANDING_WORKSPACE',
                           'refusalDetail': 'NO_TASK_ASSIGNEE', 'refusalCodeAbsentReason': None,
                           'requiredAction': 'no workspace to open the coordinator in — none of this project’s tasks has an '
                                             'assignee to borrow one from. Assign a task, or pass workspaceId.',
                           'requiredActionAbsentReason': None,
                           'landing': {'workspaceId': None, 'workspaceIdAbsentReason': 'LANDING_REFUSED', 'workspaceName': None,
                                       'workspaceNameAbsentReason': 'LANDING_REFUSED', 'agentId': None, 'agentName': None,
                                       'fixed': False}}
        return {'projectId': p['id'], 'readAt': iso(ANCHOR), 'state': 'NEVER_OPENED', 'coordination': coordination,
                'openability': openability}

    def project_graph(self, p):
        """GET /projects/:id/dependency-graph: one TASK mark per task (60 or fewer are never folded)."""
        tasks = sorted(self.project_tasks(p), key=lambda t: t['created'])
        marks = []
        for t in tasks:
            running, queued = self.run_state(t)
            marks.append({'kind': 'TASK', 'id': t['id'], 'taskId': t['id'], 'title': t['title'], 'status': t['status'],
                          'parentTaskId': None, 'workState': self.work_state(t), 'verificationState': None,
                          'completionCriterion': t['criterion'], 'autoRunWhenReady': True, 'running': running,
                          'queued': queued, 'runReason': 'TURN' if running else None, 'runStalled': False})
        edges = [{'sourceMarkId': d['id'], 'targetMarkId': t['id']} for t in tasks for d in t['dependsOn']]
        return {'marks': marks, 'edges': edges, 'taskCount': len(tasks), 'folded': False, 'truncated': False,
                'limits': {'maxTasks': 50000, 'maxMarks': 500}}


# ------------------------------------------------------------------------------------------ wiki, watch

WIKI_SPACES = [('orbit', 'Orbit', 'github.com/orbit/orbit'), ('mobile', 'Mobile clients', 'github.com/orbit/mobile'),
               ('notes', 'Team notes', None)]
WIKI_TOPICS = [('session-lifecycle', 'Session lifecycle', 'platform'), ('runner-heartbeat', 'Runner heartbeat', 'runner'),
               ('android-client', 'Android client', 'clients'), ('postgres', 'Postgres', 'data'),
               ('landing', 'Landing', 'engineering'), ('reviews', 'Reviews', 'collaboration')]
WIKI_ARTICLE_CATEGORIES = [('platform', 'Platform core'), ('runner', 'Runner & engines'), ('clients', 'Clients & UI'),
                           ('data', 'Data & backend'), ('engineering', 'Engineering workflow'), ('collaboration', 'Collaboration')]
WIKI_KINDS = ['principle', 'convention', 'decision', 'pitfall', 'recipe', 'concept']


def wiki_fields(kind, title, *key):
    """An entry's `fields` for its kind (contracts/wiki.contract.json `kinds`), in jsonb key order."""
    word = choose(WORDS, 'wf', *key)
    if kind == 'principle':
        value = {'statement': f'{title}.', 'rationale': choose(EN_DETAILS, 'why', *key)}
    elif kind == 'convention':
        value = {'rule': f'Name every {word} after what it holds.', 'scope': [choose(PATHS, 'scope', *key).rsplit('/', 1)[0]]}
    elif kind == 'decision':
        value = {'context': choose(EN_DETAILS, 'ctx', *key), 'decision': f'Keep the {word} on the server.',
                 'alternatives': [jsonb({'option': f'Keep the {word} on the device', 'whyRejected': 'Two sources of truth.'})],
                 'consequences': 'Clients read it back after every change.', 'decidedAt': iso(ANCHOR - number(300, 'd', *key) * DAY)}
    elif kind == 'pitfall':
        value = {'trigger': jsonb({'paths': [choose(PATHS, 'trigger', *key)]}), 'symptom': f'The {word} goes stale after a restart.',
                 'cause': choose(EN_DETAILS, 'cause', *key), 'fix': f'Read the {word} again on reconnect.'}
    elif kind == 'recipe':
        value = {'steps': [f'Open the {word} page.', 'Run the checks.', 'Write down the result.'],
                 'verify': jsonb({'command': choose(COMMANDS, 'verify', *key), 'expectedExit': 0})}
    else:
        value = {'definition': f'A {word} is what the server keeps for one reader.', 'boundaries': 'It is never shared across accounts.'}
    return jsonb(value)


class Knowledge:
    """Wiki spaces and entries, and watches, of a World (mixed into World)."""

    def add_wiki(self, entries, spaces=2):
        self.spaces, self.entries = [], []
        for i, (slug, title, repo) in enumerate(WIKI_SPACES[:spaces]):
            created = self.created + (30 + 40 * i) * DAY
            self.spaces.append({'id': uuid7(created, 'space', self.dataset, slug), 'slug': slug, 'title': title, 'repo': repo,
                                'created': created, 'workspaces': [w for w in self.workspaces[i * 3:i * 3 + 2]],
                                'topics': [(t, uuid7(created, 'topic', self.dataset, slug, t[0])) for t in WIKI_TOPICS[i:i + 4]]})
        weights = [3, 2, 1][:spaces]
        for n in range(entries):
            key = (self.dataset, 'entry', n)
            pick, space = number(sum(weights), 'space', *key), None
            for candidate, weight in zip(self.spaces, weights):
                if pick < weight:
                    space = candidate
                    break
                pick -= weight
            kind = WIKI_KINDS[number(len(WIKI_KINDS), 'kind', *key)]
            recorded = ANCHOR - number(240 * DAY, 'recorded', *key)
            status = choose(['active'] * 80 + ['superseded'] * 8 + ['retired'] * 5 + ['proposed'] * 5 + ['rejected'] * 2,
                            'status', *key)
            trust = 'proposed' if status in ('proposed', 'rejected') else choose(['owner'] * 4 + ['confirmed'] * 3 + ['auto'] * 2 + ['unreviewed'],
                                                                                'trust', *key)
            title = (f"{choose(EN_VERBS, 'wv', *key)} the {choose(WORDS, 'ww', *key)} "
                     f"{choose(['before a release', 'on reconnect', 'per account', 'in one place', 'after a restart'], 'wt', *key)}")
            topics = sorted({space['topics'][number(len(space['topics']), 'topic', k, *key)][0][0] for k in range(1 + number(2, 'tn', *key))})
            anchors = [jsonb({'type': 'path', 'path': choose(PATHS, 'anchor', *key)})] if chance(40, 'anchored', *key) else []
            self.entries.append({'id': uuid7(recorded, 'entry', *key), 'index': n, 'space': space, 'kind': kind, 'status': status,
                                 'trust': trust, 'title': title[:120], 'summary': (choose(EN_DETAILS, 'summary', *key) + ' '
                                                                                 + choose(ZH_DETAILS, 'summary-zh', *key))[:280],
                                 'fields': wiki_fields(kind, title, *key), 'topics': topics,
                                 'aliases': [choose(WORDS, 'alias', *key)] if chance(30, 'aliased', *key) else [],
                                 'anchors': anchors, 'recorded': recorded, 'pinned': chance(5, 'pinned', *key),
                                 'supersedes': None, 'supersededBy': None})
        actives = [e for e in self.entries if e['status'] == 'active']
        for e in self.entries:
            if e['status'] == 'superseded':
                newer = [a for a in actives if a['space'] is e['space'] and a['recorded'] > e['recorded'] and not a['supersedes']]
                if newer:
                    e['supersededBy'], newer[0]['supersedes'] = newer[0], e
                else:
                    e['status'] = 'retired'

    def entry_view(self, e):
        """The 25-key entry view (WikiService entry view)."""
        retired = e['status'] in ('superseded', 'retired', 'rejected')
        return {'id': e['id'], 'spaceId': e['space']['id'], 'kind': e['kind'], 'status': e['status'], 'trust': e['trust'],
                'currentRevision': 1, 'title': e['title'], 'summary': e['summary'], 'fields': e['fields'], 'topics': e['topics'],
                'aliases': e['aliases'], 'anchors': e['anchors'], 'anchorState': 'unchecked', 'anchorCheckedRef': None,
                'anchorCheckedAt': None, 'tainted': False, 'challenged': False, 'unsupported': False, 'pinned': e['pinned'],
                'supersedesId': e['supersedes']['id'] if e['supersedes'] else None,
                'supersededById': e['supersededBy']['id'] if e['supersededBy'] else None,
                'validFrom': iso(e['recorded']), 'validTo': iso(e['recorded'] + 30 * DAY) if retired else None,
                'recordedAt': iso(e['recorded']), 'retiredAt': iso(e['recorded'] + 30 * DAY) if retired else None}

    def entry_detail(self, e):
        """GET /wiki/entries/:id with every include (dataset-server.py drops the lists the request does not name)."""
        view = self.entry_view(e)
        history = [{'id': uuid7(e['recorded'], 'revision', e['id']), 'entryId': e['id'], 'revision': 1, 'title': e['title'],
                    'summary': e['summary'], 'fields': e['fields'], 'topics': e['topics'], 'aliases': e['aliases'],
                    'anchors': e['anchors'], 'contentSha256': digest('content', e['id']).hex(), 'authorKind': 'owner',
                    'authorUserId': self.owner, 'authorSessionId': None, 'authorToolCallId': None, 'changesetOpId': None,
                    'createdAt': iso(e['recorded'])}]
        return {**view, 'changesetId': None, 'appliedByMode': None, 'verification': None, 'sources': [],
                'history': history, 'exposure': []}

    def space_row(self, sp):
        """A row of GET /wiki/spaces."""
        return {**self.space_document(sp), 'pendingOps': 0, 'planWaiting': 0,
                'workspaceIds': [w['id'] for w in sp['workspaces']], 'docs': None}

    def space_document(self, sp):
        """GET /wiki/spaces/:id (without include=usage)."""
        maintenance = jsonb({'enabled': False, 'workspaceId': None, 'provider': 'local-vllm', 'dailyRunLimit': 8,
                             'lookbackDays': 14, 'listId': None})
        settings = jsonb({'push': True, 'autoAcceptReinforce': True, 'reviewMode': 'manual', 'automaticSpotChecks': False,
                          'maintenance': maintenance})
        return {'id': sp['id'], 'slug': sp['slug'], 'title': sp['title'], 'repoUrlNorm': sp['repo'],
                'rootCommitSha': digest('root', sp['id']).hex()[:40] if sp['repo'] else None, 'settings': settings,
                'createdAt': iso(sp['created']), 'updatedAt': iso(sp['created'] + DAY)}

    def space_entries(self, sp):
        return sorted([e for e in self.entries if e['space'] is sp], key=lambda e: (e['recorded'], e['id']), reverse=True)

    def space_reads(self, sp):
        """The space's other page-open reads, as {suffix: body}."""
        entries = self.space_entries(sp)
        topics = []
        for (slug, title, category), _ in sp['topics']:
            topics.append({'slug': slug, 'title': title, 'description': f'Entries about {title.lower()}.', 'category': category,
                           'article': None, 'parts': []})
        recent = entries[:20]
        timeline = [{'opId': uuid7(e['recorded'], 'op', e['id']), 'changesetId': uuid7(e['recorded'], 'changeset', e['id']),
                     'changesetAppliedByMode': None, 'op': 'add', 'decision': 'accepted', 'origin': 'owner', 'appliedByMode': None,
                     'spotCheck': False, 'at': iso(e['recorded']), 'entryId': e['id'], 'title': e['title'], 'kind': e['kind'],
                     'status': e['status'], 'trust': e['trust'], 'supersededById': None, 'supersededByTitle': None, 'reason': None}
                    for e in recent]
        executor = {'mode': 'server', 'serverExecutes': True}
        return {
            'docs': {'spaceId': sp['id'], 'plan': None, 'docs': {'total': 0, 'written': 0}, 'categories': []},
            'doc-index': {'spaceId': sp['id'], 'plan': None, 'items': []},
            'articles': {'spaceId': sp['id'], 'categories': [{'key': k, 'title': t, 'topics': [x for x in topics if x['category'] == k]}
                                                             for k, t in WIKI_ARTICLE_CATEGORIES], 'uncategorized': []},
            'article-index': {'spaceId': sp['id'], 'items': []},
            'share': {'link': None, 'counts': {'documents': 0, 'footnotes': 0}},
            'plan': {'spaceId': sp['id'], 'confirmed': None, 'draft': None, 'proposals': [], 'job': None},
            'plan/versions': {'spaceId': sp['id'], 'versions': []},
            'timeline': {'items': timeline},
            'health': {'spaceId': sp['id'], 'entries': sum(1 for e in entries if e['status'] == 'active'),
                       'maintenance': {'look': 'off', 'enabled': False, 'lastOkAt': None, 'lastRunAt': None,
                                       'consecutiveFailures': 0, 'backlog': 0, 'oldestPendingAt': None, 'lagSeconds': None,
                                       'dailyLimitReached': False, 'held': None, 'running': None, 'lastRun': None,
                                       'lastFailure': None},
                       'repo': {'look': 'no_workspace', 'workspace': None, 'runner': None, 'pending': 0},
                       'executor': executor,
                       'systemModel': {'state': 'unconfigured', 'model': None, 'since': None, 'checkedAt': None,
                                       'workerSeenAt': None, 'executor': executor}},
            'jobs': {'spaceId': sp['id'], 'jobs': []},
        }

    def topic_reads(self, sp):
        out = []
        for (slug, title, category), _ in sp['topics']:
            tagged = sorted([e for e in self.entries if e['space'] is sp and slug in e['topics']],
                            key=lambda e: e['recorded'], reverse=True)[:200]
            out.append({'space': sp['id'], 'slug': slug, 'body': {'slug': slug, 'title': title,
                                                                  'description': f'Entries about {title.lower()}.',
                                                                  'declared': True, 'entryCount': len(tagged),
                                                                  'entries': [self.entry_view(e) for e in tagged]}})
        return out

    # Watches -----------------------------------------------------------------------------------------

    def add_watches(self, count):
        self.watches = []
        for n in range(count):
            key = (self.dataset, 'watch', n)
            created = ANCHOR - number(40 * DAY, 'created', *key)
            state = choose(['ACTIVE'] * 12 + ['PAUSED'] * 2 + ['MATCHED'] * 3 + ['EXPIRED'] * 2 + ['CANCELLED'], 'state', *key)
            observer = None
            if chance(40, 'session-observer', *key):
                live = [s for s in self.sessions if s['view'] == 'open']
                observer = live[number(len(live), 'observer', *key)] if live else None
            on_tasks = bool(self.tasks) and chance(70, 'on-tasks', *key)
            pool = self.tasks if on_tasks else [s for s in self.sessions if s['view'] != 'trash']
            targets = [pool[number(len(pool), 'target', k, *key)] for k in range(1 + number(3, 'targets', *key))] if pool else []
            seen, unique = set(), []
            for t in targets:
                if t['id'] not in seen:
                    seen.add(t['id'])
                    unique.append(t)
            self.watches.append({'id': uuid7(created, 'watch', *key), 'created': created, 'state': state, 'observer': observer,
                                 'kind': 'TASK' if on_tasks else 'SESSION', 'targets': unique,
                                 'leaf': choose(['TASK_TERMINAL', 'TASK_DONE', 'TASK_FAILED'], 'leaf', *key) if on_tasks
                                 else choose(['SESSION_TURN_SETTLED', 'SESSION_RUN_TERMINAL'], 'leaf', *key),
                                 'expires': (created + (2 + number(3, 'ttl', *key)) * DAY) if state == 'EXPIRED'
                                 else ANCHOR + (5 + number(25, 'ttl', *key)) * DAY})

    def watch_row(self, w):
        """A row of GET /watches (WatchesService WATCH_VIEW_SELECT and named())."""
        terminal = w['state'] in ('MATCHED', 'EXPIRED', 'CANCELLED', 'REVOKED', 'UNRESOLVABLE')
        action = 'RESUME_SESSION' if w['observer'] else 'NOTIFY_USER'
        evaluated = w['expires'] if w['state'] == 'EXPIRED' else min(ANCHOR, w['expires']) - 30 * SECOND
        targets = []
        for t in w['targets']:
            if w['kind'] == 'TASK':
                running, queued = self.run_state(t)
                status = {'status': t['status'], 'running': running, 'queued': queued}
            else:
                status = {'status': t['status'], 'running': t['status'] == 'RUNNING', 'queued': t['status'] == 'PENDING'}
            satisfied = w['state'] == 'MATCHED'
            targets.append({'targetKind': w['kind'], 'targetResourceId': t['id'], 'state': 'SATISFIED' if satisfied else 'OBSERVED',
                            'targetEpoch': 0, 'lastEvaluatedAt': iso(evaluated), 'targetTitle': t['title'],
                            'targetStatus': status, 'targetTask': None})
        matches = []
        if w['state'] == 'MATCHED':
            at = w['created'] + 6 * HOUR
            delivery = {'id': uuid7(at, 'delivery', w['id']), 'action': action, 'state': 'DELIVERED', 'attempts': 1,
                        'nextAttemptAt': iso(at), 'lastError': None, 'deliveredAt': iso(at + SECOND), 'deadLetteredAt': None,
                        'createdAt': iso(at), 'updatedAt': iso(at + SECOND)}
            matches.append({'id': uuid7(at, 'match', w['id']), 'generation': 1, 'matchedAt': iso(at),
                            'reason': f"{w['leaf']} held for every target", 'predicateVersion': 1,
                            'perTargetSnapshot': {}, 'deliveries': [delivery]})
        expiry = []
        if w['state'] == 'EXPIRED':
            at = w['expires']
            expiry.append({'id': uuid7(at, 'expiry', w['id']), 'action': action, 'state': 'DELIVERED', 'attempts': 1,
                           'nextAttemptAt': iso(at), 'lastError': None, 'deliveredAt': iso(at + SECOND), 'deadLetteredAt': None,
                           'createdAt': iso(at), 'updatedAt': iso(at + SECOND), 'kind': 'EXPIRY', 'expirySnapshot': None})
        return {'id': w['id'], 'observerType': 'SESSION' if w['observer'] else 'USER',
                'observerSessionId': w['observer']['id'] if w['observer'] else None, 'predicateVersion': 1,
                'predicate': jsonb({'kind': 'ALL', 'leaf': w['leaf'], 'over': 'ALL_TARGETS'}), 'mode': 'ONE_SHOT',
                'action': action, 'state': w['state'], 'generation': len(matches), 'debounceSeconds': None, 'wakeBudget': None,
                'holding': False, 'windowOpenedAt': None, 'windowClosesAt': None, 'windowCrossings': 0,
                'expiresAt': iso(w['expires']), 'nextEvaluateAt': None if terminal else iso(w['expires'] if w['state'] == 'PAUSED'
                                                                                             else evaluated + MINUTE),
                'lastEvaluatedAt': iso(evaluated), 'idempotencyKey': None, 'createdAt': iso(w['created']),
                'updatedAt': iso(evaluated), 'targets': targets, 'matches': matches, 'expiryDeliveries': expiry}


def wiki_watch_routes(bundle, world, prefix):
    spaces = sorted(world.spaces, key=lambda sp: sp['slug'])
    bundle.json(f'{prefix}/wiki-spaces.json', wire([world.space_row(sp) for sp in spaces]), rows=len(spaces))
    bundle.jsonl(f'{prefix}/wiki-space-documents.jsonl', [wire(world.space_document(sp)) for sp in spaces], rows=len(spaces))
    entries = sorted(world.entries, key=lambda e: (e['recorded'], e['id']), reverse=True)
    bundle.jsonl(f'{prefix}/wiki-entries.jsonl', [{'space': base62(e['space']['id']), 'row': wire(world.entry_view(e))}
                                                  for e in entries], rows=len(entries))
    bundle.jsonl(f'{prefix}/wiki-entry-details.jsonl', [wire(world.entry_detail(e)) for e in entries], rows=len(entries))
    reads = {}
    for sp in spaces:
        for suffix, body in world.space_reads(sp).items():
            reads.setdefault(suffix, []).append({'key': base62(sp['id']), 'body': wire(body)})
    routes = [['GET', '/api/wiki/spaces', 'file', f'{prefix}/wiki-spaces.json'],
              ['GET', '/api/wiki/review', 'json', []],
              ['GET', '/api/wiki/system-model', 'json', {'state': 'unconfigured', 'model': None, 'since': None, 'checkedAt': None,
                                                         'workerSeenAt': None, 'executor': {'mode': 'server', 'serverExecutes': True}}]]
    for suffix, rows in reads.items():
        name = f"{prefix}/wiki-space-{suffix.replace('/', '-')}.jsonl"
        bundle.jsonl(name, rows, rows=len(rows))
        routes.append(['GET', f'/api/wiki/spaces/:id/{suffix}', 'keyed', {'file': name, 'missing': 'no such wiki space'}])
    topics = [t for sp in spaces for t in world.topic_reads(sp)]
    bundle.jsonl(f'{prefix}/wiki-topics.jsonl', [{'space': base62(t['space']), 'slug': t['slug'], 'body': wire(t['body'])}
                                                 for t in topics], rows=len(topics))
    watches = sorted(world.watches, key=lambda w: (w['created'], w['id']), reverse=True)
    bundle.jsonl(f'{prefix}/watches.jsonl', [wire(world.watch_row(w)) for w in watches], rows=len(watches))
    return routes


def wiki_watch_failures(world):
    if not world.entries:
        return []
    failing = sorted(world.entries, key=lambda e: e['recorded'])[0]
    return [{'method': 'GET', 'path': f"/api/wiki/entries/{base62(failing['id'])}", 'status': 500}]


def world_counts(world):
    return {'wikiSpaces': len(world.spaces), 'wikiEntries': len(world.entries), 'watches': len(world.watches)}


# ----------------------------------------------------------------------------------------------- world

SYSTEM_TAGS = [('Red', '#FF3B30'), ('Orange', '#FF9500'), ('Yellow', '#FFCC00'), ('Green', '#34C759'), ('Blue', '#007AFF'),
               ('Purple', '#AF52DE'), ('Gray', '#8E8E93')]
CUSTOM_TAGS = ['release', 'bug', 'design', '性能', 'docs', 'infra', '客户反馈', 'research']
RUNNERS = [('hpc-build-01', 'HPC build', 'hpc-build-01.lan', True, 16, [('claude', '2.1.300'), ('codex', '0.140.0')]),
           ('mac-mini-studio', 'Mac mini', 'mac-mini.local', True, 8, [('claude', '2.1.300')]),
           ('old-laptop', None, 'old-laptop.local', False, 4, [('claude', '2.0.12')])]
FOLDER_NAMES = ['Release', 'Bugs', 'Design', '研究', 'Ops', 'Archive', '客户', 'Spikes', 'Docs', 'Perf']


def jsonb(value):
    """A Postgres jsonb object's key order: shorter keys first, then bytewise."""
    return {k: value[k] for k in sorted(value, key=lambda k: (len(k.encode()), k.encode()))}


class World(Work, Knowledge):
    """One account's rows before they are rendered in the wire shape."""

    def __init__(self, dataset, email, name, role):
        self.dataset = dataset
        self.email, self.name, self.role = email, name, role
        self.created = ANCHOR - 420 * DAY
        self.owner = uuid7(self.created, 'user', dataset, email)
        self.runners, self.workspaces, self.folders, self.tags, self.sessions = [], [], [], [], []
        self.events = {}
        self.lists, self.projects, self.tasks = [], [], []
        self.spaces, self.entries, self.watches = [], [], []

    # The directory -----------------------------------------------------------------------------------

    def add_runners(self, count=len(RUNNERS)):
        for i, (name, display, host, online, cap, engines) in enumerate(RUNNERS[:count]):
            enrolled = self.created + (i + 1) * 3 * DAY
            self.runners.append({'id': uuid7(enrolled, 'runner', self.dataset, i), 'name': name, 'displayName': display,
                                 'hostname': host, 'online': online, 'maxConcurrent': cap, 'engines': engines,
                                 'labels': ['linux'] if i == 0 else ['macos'] if i == 1 else [],
                                 'enrolled': enrolled, 'position': i if i < 2 else None})

    def add_workspaces(self, count):
        for i in range(count):
            created = self.created + (10 + i * 9) * DAY
            runner = None
            if self.runners:
                runner = self.runners[0] if i < 9 else self.runners[1] if i < 17 else \
                    self.runners[2] if i < 19 and len(self.runners) > 2 else None
            name = WORKSPACE_NAMES[i % len(WORKSPACE_NAMES)] + ('' if i < len(WORKSPACE_NAMES) else f'-{i}')
            self.workspaces.append({
                'id': uuid7(created, 'workspace', self.dataset, i), 'index': i, 'name': name,
                'slug': f'ws-{i:02d}', 'created': created, 'runner': runner,
                'position': i if i < 12 else None, 'enabled': i != 18,
                'provider': 'codex' if i % 5 == 3 else 'claude', 'model': None if i % 4 else MODELS['claude'],
                'effort': 'high' if i % 3 == 0 else None,
                'description': None if i % 2 else f'{name} — synthetic workspace {i + 1} of {count}',
                'runnerIds': [r['id'] for r in self.runners]})

    def add_tags(self, custom):
        for i, (name, color) in enumerate(SYSTEM_TAGS):
            self.tags.append({'id': uuid7(self.created, 'tag', self.owner, name), 'name': name, 'color': color,
                              'isSystem': True, 'position': i})
        for i, name in enumerate(CUSTOM_TAGS[:custom]):
            self.tags.append({'id': uuid7(self.created + (i + 1) * DAY, 'tag', self.owner, name), 'name': name,
                              'color': SYSTEM_TAGS[(len(SYSTEM_TAGS) + i) % len(SYSTEM_TAGS)][1], 'isSystem': False,
                              'position': len(SYSTEM_TAGS) + i})

    def add_folders(self, workspaces, per_workspace):
        for w in self.workspaces[:workspaces]:
            for j in range(per_workspace):
                created = w['created'] + (j + 1) * DAY
                self.folders.append({'id': uuid7(created, 'folder', self.dataset, w['index'], j),
                                     'workspaceId': w['id'], 'name': FOLDER_NAMES[(w['index'] + j) % len(FOLDER_NAMES)],
                                     'workspace': w})

    def add_sessions(self, views, turns, pairs, *, pinned, span_days, extra=None, titles=None, statuses=None):
        """`views` is how many sessions go to (open, completed, trash); `extra(index)` returns per-session text."""
        weights = [len(self.workspaces) - k for k in range(len(self.workspaces))]
        total_weight = sum(weights)
        kinds = ['open'] * views[0] + ['completed'] * views[1] + ['trash'] * views[2]
        for index, view in enumerate(kinds):
            key = (self.dataset, index)
            pick, w = number(total_weight, 'ws', *key), None
            for candidate, weight in zip(self.workspaces, weights):
                if pick < weight:
                    w = candidate
                    break
                pick -= weight
            created = ANCHOR - span_days * DAY + number(span_days * DAY - 3 * DAY, 'created', *key)
            runner = w['runner'] if w else None
            status, reason, error = (statuses or {}).get(index) or self._status(view, runner, key)
            folders = [f for f in self.folders if f['workspaceId'] == w['id']] if w else []
            folder = folders[number(len(folders), 'folder', *key)] if folders and chance(55, 'in-folder', *key) else None
            tags = []
            if self.tags and chance(40, 'tagged', *key):
                tags.append(self.tags[number(len(self.tags), 'tag', *key)])
                if chance(15, 'second-tag', *key):
                    second = self.tags[number(len(self.tags), 'tag2', *key)]
                    if second is not tags[0]:
                        tags.append(second)
                tags.sort(key=lambda t: (not t['isSystem'], t['position']))
            title = (titles or {}).get(index) or title_of(*key)
            s = {'dataset': self.dataset, 'index': index, 'id': uuid7(created, 'session', *key), 'title': title,
                 'created': created, 'view': view, 'status': status, 'endReason': reason, 'error': error,
                 'workspace': w, 'runner': runner, 'provider': w['provider'] if w else 'claude',
                 'permissionMode': choose(['default', 'default', 'acceptEdits', 'plan'], 'mode', *key),
                 'effort': w['effort'] if w else None, 'folderId': folder['id'] if folder else None,
                 'tags': [{k: t[k] for k in ('id', 'name', 'color', 'isSystem', 'position')} for t in tags],
                 'taskId': None, 'taskTitle': None, 'coordinates': None, 'coordinatesTitle': None, 'membership': None,
                 'branch': f"orbit/{choose(WORDS, 'branch', *key)}-{digest('branch', *key).hex()[:6]}" if chance(30, 'wt', *key) else None,
                 'pinnedAt': None, 'completedAt': None, 'deletedAt': None, 'recapText': None, 'recapAt': None}
            if s['provider'] == 'codex':
                s['permissionMode'] = 'default'
            s['baseSha'] = digest('base', *key).hex()[:40] if s['branch'] else None
            events, times = transcript(s, turns(index) if callable(turns) else turns,
                                       pairs(index) if callable(pairs) else pairs, extra=extra(index) if extra else None)
            summarize(s, events, times)
            if view == 'completed':
                s['completedAt'] = s['lastTurn'] + (5 + number(600, 'done', *key)) * MINUTE
            if view == 'trash':
                s['deletedAt'] = s['lastTurn'] + (10 + number(900, 'gone', *key)) * MINUTE
            if chance(50, 'recap', *key) and s['numTurns']:
                s['recapText'] = f"{title}: {choose(['working on it', 'waiting for review', 'fixed and tested', '已定位原因，等待确认'], 'recap', *key)}"
                s['recapAt'] = s['lastTurn'] + 2 * MINUTE
            self.sessions.append(s)
            self.events[s['id']] = events
        open_sessions = [s for s in self.sessions if s['view'] == 'open']
        for s in open_sessions[:pinned]:
            s['pinnedAt'] = s['created'] + HOUR

    def _status(self, view, runner, key):
        if view == 'trash':
            return 'CANCELLED', 'deleted', None
        if view == 'completed':
            return choose([('SUCCEEDED', None, None), ('AWAITING_INPUT', None, None), ('CANCELLED', 'completed', None)],
                          'done-status', *key)
        roll = number(100, 'status', *key)
        live = bool(runner and runner['online'])
        if roll < 8 and live:
            return 'RUNNING', None, None
        if roll < 12 and live:
            return 'PENDING', None, None
        if roll < 18:
            return 'FAILED', None, choose(['API Error: 529 Overloaded', 'The runner restarted during the turn.',
                                           'exceeded retry limit, last status: 429 Too Many Requests'], 'error', *key)
        if roll < 24:
            return 'CANCELLED', 'ended', None
        if roll < 30:
            return 'INTERRUPTED', None, None
        return 'AWAITING_INPUT', None, None

    # Rendering ---------------------------------------------------------------------------------------

    def user(self):
        return user_row(self.owner, self.email, self.name, self.role, self.created)

    def workspace_rows(self):
        rows = [workspace_row(w, self.owner, w['runner']) for w in self.workspaces]
        # WorkspacesService.list order: placed ones by position, then never-placed ones by creation.
        rows.sort(key=lambda r: (r['position'] is None, r['position'] or 0, r['createdAt']))
        return rows

    def runner_rows(self):
        busy = {}
        for s in self.sessions:
            if s['runner'] and s['status'] in ('RUNNING', 'PENDING'):
                busy[s['runner']['id']] = busy.get(s['runner']['id'], 0) + 1
        return [runner_row(r, self.owner, busy.get(r['id'], 0)) for r in self.runners]

    def folder_rows(self):
        rows = [{'id': f['id'], 'workspaceId': f['workspaceId'], 'name': f['name']} for f in self.folders]
        return sorted(rows, key=lambda r: (r['name'], r['id']))

    def tag_rows(self):
        return [{k: t[k] for k in ('id', 'name', 'color', 'isSystem', 'position')} for t in self.tags]

    def session_rows(self, view):
        rows = [s for s in self.sessions if s['view'] == view]
        if view == 'completed':
            rows.sort(key=lambda s: (-s['completedAt'], -s['created']))
        else:
            rows.sort(key=lambda s: (s['pinnedAt'] is None, -s['lastTurn'], -s['created']))
        return [session_row(s) for s in rows]

    def session_details(self):
        full = {w['id']: workspace_row(w, self.owner, w['runner']) for w in self.workspaces}
        out = []
        for s in self.sessions:
            workspace = None
            if s['workspace']:
                workspace = {k: v for k, v in full[s['workspace']['id']].items()
                             if k not in ('runner', 'lastEngine', 'lastProvider', 'provider', 'providerBuiltin',
                                          'repoHealth', 'repoCleanup', 'antigravityKeyAvailableByRunner')}
                workspace['antigravityKeyAvailableByRunner'] = {s['runner']['id']: False} if s['runner'] else {}
            out.append(session_detail(s, self.owner, workspace))
        return out

    def search_hit(self, s, field, snippet):
        state, _ = session_state(s)
        w = s['workspace']
        return {'id': s['id'], 'title': s['title'], 'status': s['status'], 'runStatus': s['status'],
                'sessionState': state['sessionState'], 'runState': state['runState'],
                'lifecycleState': state['lifecycleState'], 'filingState': state['filingState'],
                'agent': {'id': w['id'], 'name': w['name']} if w else None,
                'runnerId': s['runner']['id'] if s['runner'] else None, 'taskId': s['taskId'], 'taskTitle': s['taskTitle'],
                'lastTurnAt': iso(s['lastTurn']), 'createdAt': iso(s['created']), 'completedAt': iso(s['completedAt']),
                'archivedAt': iso(s['completedAt']), 'deletedAt': iso(s['deletedAt']), 'endReason': s['endReason'],
                'matchField': field, 'snippet': snippet, 'sessionKind': 'CONVERSATION'}

    def search(self, q, limit=50):
        """GET /sessions/search's answer for `q` (SessionsService.search): titles first, then the latest matching
        message, newest first, at most 50 rows with the true total. Trash is not searched."""
        live = [s for s in self.sessions if s['view'] != 'trash']
        live.sort(key=lambda s: -s['lastTurn'])
        if not q.strip():
            rows = live[:limit]
            return {'q': '', 'contentSearched': False, 'total': len(rows),
                    'hits': [self.search_hit(s, 'recent', None) for s in rows]}
        needle = q.strip().lower()
        content = len(q.strip()) >= 3
        hits = []
        for s in live:
            if needle in s['title'].lower():
                hits.append(self.search_hit(s, 'title', s['title']))
        for s in live:
            if needle in s['title'].lower() or not content:
                continue
            for e in reversed(self.events[s['id']]):
                text = e['payload'].get('text') if e['type'] in ('user', 'assistant') else None
                if text and needle in text.lower():
                    at = text.lower().index(needle)
                    window = ' '.join(text[max(0, at - 60):at + len(needle) + 60].split())
                    hits.append(self.search_hit(s, 'message', window))
                    break
        return {'q': q.strip(), 'contentSearched': content, 'total': len(hits), 'hits': hits[:limit]}

    def events_rows(self):
        for s in self.sessions:
            for e in self.events[s['id']]:
                yield {'session': base62(s['id']), 'event': wire(dict(e))}


# ----------------------------------------------------------------------------------------------- media

# A 5×7 block font for the words the DS6 pictures carry ("DS6", the picture's number, its format).
FONT = {
    '0': ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
    '1': ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
    '2': ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
    '3': ['11110', '00001', '00001', '01110', '00001', '00001', '11110'],
    '4': ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
    '5': ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
    '6': ['00110', '01000', '10000', '11110', '10001', '10001', '01110'],
    '7': ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
    '8': ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
    '9': ['01110', '10001', '10001', '01111', '00001', '00010', '01100'],
    'D': ['11110', '10001', '10001', '10001', '10001', '10001', '11110'],
    'S': ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
    'P': ['11110', '10001', '10001', '11110', '10000', '10000', '10000'],
    'N': ['10001', '11001', '10101', '10011', '10001', '10001', '10001'],
    'G': ['01110', '10001', '10000', '10111', '10001', '10001', '01111'],
    'J': ['00111', '00010', '00010', '00010', '00010', '10010', '01100'],
    'E': ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
    'W': ['10001', '10001', '10001', '10101', '10101', '10101', '01010'],
    'B': ['11110', '10001', '10001', '11110', '10001', '10001', '11110'],
    '#': ['01010', '01010', '11111', '01010', '11111', '01010', '01010'],
    ' ': ['00000'] * 7,
}
PICTURE = (1440, 2560)
FORMATS = ('png', 'jpg', 'webp')


def picture_blocks(index, fmt):
    """The picture as palette indexes per 8×8 block (180 × 320): a frame, diagonal bands and three lines of text."""
    cols, rows = PICTURE[0] // 8, PICTURE[1] // 8
    grid = [[0] * cols for _ in range(rows)]
    band = 9 + number(12, 'band', index)
    for y in range(rows):
        for x in range(cols):
            if (x + y + index * 7) // band % 3 == 0:
                grid[y][x] = 1 + number(2, 'band-colour', index)  # 1 or 2
            if x < 3 or y < 3 or x >= cols - 3 or y >= rows - 3:
                grid[y][x] = 4
    for line, text in enumerate(('DS6', f'#{index:02d}', {'png': 'PNG', 'jpg': 'JPEG', 'webp': 'WEBP'}[fmt])):
        scale = 4  # a font pixel is 4×4 blocks = 32×32 px
        top = 40 + line * 70
        left = (cols - len(text) * 6 * scale) // 2
        for c, ch in enumerate(text):
            for gy, bits in enumerate(FONT[ch]):
                for gx, bit in enumerate(bits):
                    if bit == '1':
                        for dy in range(scale):
                            for dx in range(scale):
                                grid[top + gy * scale + dy][left + (c * 6 + gx) * scale + dx] = 7
    return grid


def picture(index, fmt, pad_to=None):
    """DS6 picture `index` (1..20) as `fmt` bytes, and its palette (red, green, blue levels per bit)."""
    levels = tuple((16 + number(80, 'lo', c, index), 160 + number(80, 'hi', c, index)) for c in range(3))

    def rgb(i):
        return levels[0][i >> 2 & 1], levels[1][i >> 1 & 1], levels[2][i & 1]
    grid = picture_blocks(index, fmt)

    def scanlines():
        for line in grid:
            row = [i for i in line for _ in range(8)]
            for _ in range(8):
                yield row
    if fmt == 'png':
        return images.png(*PICTURE, [rgb(i) for i in range(8)], scanlines(), pad_to=pad_to)
    if fmt == 'jpg':
        return images.jpeg(*PICTURE, lambda bx, by: rgb(grid[by][bx]))
    return images.webp(*PICTURE, levels, scanlines())


ZH_PARAGRAPHS = ['这一段用来检查长文本在手机上的换行、选择和复制是否正常，标点符号“引号”、（括号）和——破折号都应该保持原样。',
                 '如果滚动到中间再切到后台，回来时应当停在原来的位置，而不是跳到底部。',
                 '表格、代码块和列表混在一起时，渲染不能错位，也不能把代码块里的符号当成格式。',
                 '在弱网环境下重新进入会话，已经加载的内容应该先显示出来，再在后台补齐最新的消息。']


def markdown_20k():
    """One Markdown message of exactly 20,000 characters (A01 DS6 单条2万字Markdown), BMP only."""
    parts, n = ['# 两万字 Markdown 渲染样例\n\n'], 0
    while sum(map(len, parts)) < 20_000:
        n += 1
        parts.append(f'## 第 {n} 节 · Section {n}\n\n')
        for p in range(3):
            parts.append(choose(ZH_PARAGRAPHS, 'md', n, p) + ' ' + choose(EN_DETAILS, 'md-en', n, p) + '\n\n')
        if n % 3 == 0:
            parts.append('| 项目 | Value | 说明 |\n| --- | ---: | :---: |\n' + ''.join(
                f'| {choose(WORDS, "md-row", n, r)} | {number(10_000, "md-v", n, r)} | 第{r + 1}行 |\n' for r in range(6)) + '\n')
        if n % 4 == 0:
            parts.append('```kotlin\n' + '\n'.join(code_lines(8, 'md-code', n)) + '\n```\n\n')
        if n % 5 == 0:
            parts.append('- [x] 已完成的条目\n- [ ] 未完成的条目\n  - 嵌套条目 nested\n\n> 引用段落：' + choose(ZH_PARAGRAPHS, 'q', n) + '\n\n')
    text = ''.join(parts)[:20_000 - len('\n\n全文结束。')] + '\n\n全文结束。'
    assert len(text) == 20_000
    return text


def long_draft():
    """A draft of 6,000 characters for the composer (draft persistence across process death)."""
    text = ''.join(f'{i + 1}. ' + choose(ZH_PARAGRAPHS, 'draft', i) + choose(EN_DETAILS, 'draft-en', i) + '\n' for i in range(60))
    return (text * 2)[:6000]


# Pinyin a tester types with a Chinese IME, and what committing the first candidate gives.
IME_SEQUENCES = [
    {'keys': 'zhongwen', 'commit': '中文'}, {'keys': 'shurufa', 'commit': '输入法'}, {'keys': 'huihua', 'commit': '会话'},
    {'keys': 'fujian', 'commit': '附件'}, {'keys': 'shangchuan', 'commit': '上传'}, {'keys': 'quxiao', 'commit': '取消'},
    {'keys': 'caogao', 'commit': '草稿'}, {'keys': 'chongshi', 'commit': '重试'}]


# What the upload contract allows (apiserver AttachmentsController, multer; Android AttachmentLimits and OrbitKit
# Composer agree): an image file picked from storage up to 5 MiB, any file up to 25 MiB, never an empty one.
MAX_IMAGE = 5 * 1024 * 1024
MAX_FILE = 25 * 1024 * 1024


def filler(size, *key):
    """`size` bytes that do not compress: 1 MiB of SHA-256 output from the key, repeated."""
    block = b''.join(digest('fill', i, *key) for i in range(32768))
    return (block * (size // len(block) + 1))[:size]


def jpeg_padded(data, size):
    """A JPEG grown to exactly `size` bytes with COM segments right after SOI (decoders skip comments)."""
    room = size - len(data)
    if room < 0 or 0 < room < 4:
        raise ValueError(f'cannot pad a {len(data)}-byte JPEG to {size} bytes')
    segments = []
    while room:
        length = min(room, 65537)  # a segment is 4 bytes of marker and length plus up to 65533 bytes
        if room - length in (1, 2, 3):  # never leave less than a whole empty segment
            length = room - 4
        body = length - 4
        segments.append(b'\xFF\xFE' + (body + 2).to_bytes(2, 'big') + bytes(body))
        room -= length
    return data[:2] + b''.join(segments) + data[2:]


def pdf(title, lines):
    """A one-page PDF with Helvetica text, offsets computed so the xref is exact."""
    stream = 'BT /F1 18 Tf 72 760 Td (' + title + ') Tj ET\n' + ''.join(
        f'BT /F1 11 Tf 72 {730 - 16 * i} Td ({line}) Tj ET\n' for i, line in enumerate(lines))
    objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
               '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R '
               '/Resources << /Font << /F1 5 0 R >> >> >>',
               f'<< /Length {len(stream)} >>\nstream\n{stream}endstream',
               '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>']
    out, offsets = '%PDF-1.4\n', []
    for n, body in enumerate(objects, 1):
        offsets.append(len(out))
        out += f'{n} 0 obj\n{body}\nendobj\n'
    xref = len(out)
    out += f'xref\n0 {len(objects) + 1}\n0000000000 65535 f \n' + ''.join(f'{o:010d} 00000 n \n' for o in offsets)
    out += f'trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n'
    return out.encode('ascii')


def zip_stored(entries):
    """A ZIP of stored (uncompressed) entries with a fixed timestamp: the same bytes on every run."""
    import io
    import zipfile
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, 'w', compression=zipfile.ZIP_STORED) as archive:
        for name, data in entries:
            info = zipfile.ZipInfo(name, date_time=(2026, 10, 25, 12, 0, 0))
            info.external_attr = 0o644 << 16
            info.create_system = 3
            archive.writestr(info, data)
    return buffer.getvalue()


def ds6_files():
    """Every file DS6 offers for upload: (path, mime, bytes, note)."""
    files = []
    for index in range(1, 21):
        fmt = FORMATS[(index - 1) % 3]
        data = picture(index, fmt)
        mime = {'png': 'image/png', 'jpg': 'image/jpeg', 'webp': 'image/webp'}[fmt]
        files.append((f'files/images/ds6-{index:02d}.{fmt}', mime, data,
                      {'width': PICTURE[0], 'height': PICTURE[1], 'format': fmt, 'case': 'DS3-size picture'}))
    base_jpg = picture(22, 'jpg')
    for label, size, case in (('5mib-minus-1', MAX_IMAGE - 1, 'image just under the 5 MiB picked-image limit'),
                              ('5mib', MAX_IMAGE, 'image exactly at the 5 MiB limit (accepted)'),
                              ('5mib-plus-1', MAX_IMAGE + 1, 'image one byte over 5 MiB (the client refuses it)')):
        files.append((f'files/limits/image-{label}.png', 'image/png', picture(21, 'png', pad_to=size),
                      {'width': PICTURE[0], 'height': PICTURE[1], 'format': 'png', 'case': case}))
    for label, size, case in (('5mib', MAX_IMAGE, 'JPEG exactly at the 5 MiB limit (accepted)'),
                              ('5mib-plus-1', MAX_IMAGE + 1, 'JPEG one byte over 5 MiB (the client refuses it)')):
        files.append((f'files/limits/image-{label}.jpg', 'image/jpeg', jpeg_padded(base_jpg, size),
                      {'width': PICTURE[0], 'height': PICTURE[1], 'format': 'jpg', 'case': case}))
    for label, size, case in (('empty', 0, 'empty file (the client says "File is empty", the server 400 empty file)'),
                              ('1-byte', 1, 'smallest file the server accepts'),
                              ('25mib-minus-1', MAX_FILE - 1, 'file just under the 25 MiB limit'),
                              ('25mib', MAX_FILE, 'file exactly at the 25 MiB limit (accepted)'),
                              ('25mib-plus-1', MAX_FILE + 1, 'file one byte over 25 MiB (client refuses; server 413)')):
        ext = 'txt' if size <= 1 else 'bin'
        data = b'' if size == 0 else b'x' if size == 1 else filler(size, 'limit', label)
        files.append((f'files/limits/file-{label}.{ext}', 'text/plain' if ext == 'txt' else 'application/octet-stream',
                      data, {'case': case}))
    notes = ('# DS6 笔记\n\n' + '\n\n'.join(ZH_PARAGRAPHS) + '\n').encode()
    table = ('name,value,说明\n' + ''.join(f'{choose(WORDS, "csv", i)},{number(1000, "csv-v", i)},第{i + 1}行\n'
                                         for i in range(40))).encode()
    report = pdf('DS6 attachment report', [f'Line {i + 1}: {choose(EN_DETAILS, "pdf", i)}' for i in range(30)])
    files += [('files/docs/notes-zh.md', 'text/markdown', notes, {'case': 'UTF-8 Chinese Markdown'}),
              ('files/docs/table.csv', 'text/csv', table, {'case': 'CSV'}),
              ('files/docs/report.pdf', 'application/pdf', report, {'case': 'PDF'}),
              ('files/docs/archive.zip', 'application/zip',
               zip_stored([('notes-zh.md', notes), ('table.csv', table), ('report.pdf', report)]), {'case': 'ZIP'})]
    return files


def business_routes(bundle, world, prefix):
    """Tasks, task lists, projects, wiki and watches of `world`: their files, and the routes that serve them.
    The page, count and search reads are cut from these files by dataset-server.py."""
    routes_side = []
    tasks = sorted(world.tasks, key=lambda t: (t['created'], t['id']), reverse=True)  # TasksService page order
    bundle.jsonl(f'{prefix}/tasks.jsonl', [wire(world.task_row(t)) for t in tasks], rows=len(tasks))
    bundle.jsonl(f'{prefix}/task-details.jsonl', [wire(world.task_detail(t)) for t in tasks], rows=len(tasks))
    lists = sorted(world.lists, key=lambda l: l['created'], reverse=True)
    bundle.json(f'{prefix}/task-lists.json', wire([world.list_row(l) for l in lists]), rows=len(lists))
    bundle.jsonl(f'{prefix}/task-list-documents.jsonl', [wire(world.list_document(l)) for l in lists], rows=len(lists))
    projects = sorted(world.projects, key=lambda p: p['created'], reverse=True)
    bundle.json(f'{prefix}/projects.json', wire([world.project_row(p) for p in projects]), rows=len(projects))
    sidebar = [world.sidebar_row(p) for p in projects if p['status'] == 'OPEN']
    bundle.json(f'{prefix}/projects-sidebar.json', wire(sidebar), rows=len(sidebar))
    bundle.jsonl(f'{prefix}/project-documents.jsonl', [wire(world.project_document(p)) for p in projects], rows=len(projects))
    rows = []
    for p in projects:
        for t in sorted(world.project_tasks(p), key=lambda t: (t['created'], t['id']), reverse=True):
            rows.append({'project': base62(p['id']), 'row': wire(world.project_task_row(t))})
    bundle.jsonl(f'{prefix}/project-task-rows.jsonl', rows, rows=len(rows))
    side = {'owner-confirmation': world.owner_confirmation, 'attribution': world.attribution, 'dependency-graph': world.task_graph}
    for suffix, read in side.items():
        name = f'{prefix}/task-{suffix}.jsonl'
        bundle.jsonl(name, [{'key': base62(t['id']), 'body': wire(read(t))} for t in tasks], rows=len(tasks))
        routes_side.append(['GET', f'/api/tasks/:id/{suffix}', 'keyed', {'file': name, 'missing': 'task not found'}])
    keyed = {
        'acceptance-confirmation': [{'key': base62(p['id']), 'body': wire(world.acceptance_confirmation(p))} for p in projects],
        'criteria-decisions': [{'key': base62(p['id']), 'body': wire(world.criteria_decisions(p))} for p in projects],
        'panorama': [{'key': base62(p['id']), 'body': wire(world.panorama(p))} for p in projects],
        'ready': [{'key': base62(p['id']), 'body': wire(world.ready(p))} for p in projects],
        'coordinator-status': [{'key': base62(p['id']), 'body': wire(world.coordinator_status(p))} for p in projects],
        'dependency-graph': [{'key': base62(p['id']), 'body': wire(world.project_graph(p))} for p in projects],
        'open-items': [{'key': base62(p['id']), 'body': wire(world.project_open_items(p))} for p in projects],
        'integration': [{'key': base62(p['id']), 'body': wire(world.project_integration(p))} for p in projects],
        'promotion': [{'key': base62(p['id']), 'body': None} for p in projects],  # none: 200 with an empty body
    }
    for name, body in keyed.items():
        bundle.jsonl(f'{prefix}/project-{name}.jsonl', body, rows=len(body))
    suffixes = {'acceptance-confirmation': 'acceptance/confirmation', 'criteria-decisions': 'acceptance/criteria-decisions/pending',
                'panorama': 'panorama', 'ready': 'panorama/ready', 'coordinator-status': 'coordinator/status',
                'dependency-graph': 'dependency-graph'}
    for name, suffix in suffixes.items():
        routes_side.append(['GET', f'/api/projects/:id/{suffix}', 'keyed',
                            {'file': f'{prefix}/project-{name}.jsonl', 'missing': 'project not found'}])
    routes = [
        ['GET', '/api/task-lists', 'file', f'{prefix}/task-lists.json'],
        ['GET', '/api/tasks/:id', 'record', {'file': f'{prefix}/task-details.jsonl', 'missing': 'task not found'}],
        ['GET', '/api/tasks/:id/share', 'json', {'link': None, 'counts': {'comments': 0, 'files': 0, 'transcripts': 0}}],
        ['GET', '/api/projects/:id/share', 'json', {'link': None, 'counts': {'tasks': 0, 'comments': 0, 'files': 0, 'runs': 0,
                                                                              'transcripts': 0}}],
        ['GET', '/api/projects/:id/handoffs', 'json', []],
        ['GET', '/api/projects/:id/promotions/merged', 'json', []],
        ['GET', '/api/projects', 'file', f'{prefix}/projects.json'],
        ['GET', '/api/projects/sidebar', 'file', f'{prefix}/projects-sidebar.json'],
        ['GET', '/api/projects/:id', 'record', {'file': f'{prefix}/project-documents.jsonl', 'missing': 'project not found'}],
        ['GET', '/api/projects/:id/open-items', 'keyed', {'file': f'{prefix}/project-open-items.jsonl', 'missing': 'project not found'}],
        ['GET', '/api/projects/:id/integration', 'keyed', {'file': f'{prefix}/project-integration.jsonl', 'missing': 'project not found'}],
        ['GET', '/api/projects/:id/promotions/current', 'keyed', {'file': f'{prefix}/project-promotion.jsonl', 'missing': 'project not found'}],
    ]
    return routes + routes_side + wiki_watch_routes(bundle, world, prefix)



# -------------------------------------------------------------------------------------------- datasets

SPEC = {  # A01 v1 §6 (a01-decisions-v1.md), as the owner approved it with D09 on 2026-10-04; translated
    'DS0': 'DS0: an empty account in two roles, user and ADMIN; signed out, first sign-in, valid cache, expired token, '
           'revoked permission, wrong server',
    'DS1': 'DS1 daily: 20 workspaces, 200 sessions, 100 tasks, 20 projects, 100 wiki entries, 20 watches; 200 durable '
           'events per session; no results, load failures and deep links to deleted objects',
    'DS2': 'DS2 large directory: 20 workspaces, 2,000 sessions, 2,000 tasks, 100 projects, 500 wiki entries, 100 watches; '
           '25 folders across 5 workspaces; fixed sort and search words; page boundaries, permission change and bulk '
           'status change',
    'DS6': 'DS6 attachments and input: the 20 DS3 pictures, JPEG/PNG/WebP, legal and boundary file sizes (per the upload '
           'contract), interrupted and retried downloads; Chinese composition input, long drafts, sending/cancelling/'
           'process death before an upload finishes; one 20,000-character Markdown message',
}


def account_entry(world, prefix='api'):
    """accounts.json: how dataset-server.py signs the account in, where its files are, and its user rows."""
    return {'email': world.email, 'password': PASSWORD, 'role': world.role, 'files': prefix,
            'user': wire(world.user()),
            'admin': wire(admin_row(world.owner, world.email, world.name, world.role, world.created))}


def directory_files(bundle, world, prefix='api'):
    """The account directory: what the Android cache stores (RealtimeRest.directory) and its record files."""
    rows = {'workspaces': wire(world.workspace_rows()), 'runners': wire(world.runner_rows()),
            'session-folders': wire(world.folder_rows()), 'session-tags': wire(world.tag_rows())}
    for name, body in rows.items():
        bundle.json(f'{prefix}/{name}.json', body, rows=len(body))
    views = {}
    for view in ('open', 'completed', 'trash'):
        views[view] = wire(world.session_rows(view))
        bundle.json(f'{prefix}/sessions-{view}.json', views[view], rows=len(views[view]))
    details = [wire(d) for d in world.session_details()]
    if details:
        bundle.jsonl(f'{prefix}/session-details.jsonl', details, rows=len(details))
    events = list(world.events_rows())
    if events:
        lines = [encode(e['event']) for e in events]
        types = {}
        for e in events:
            types[e['event']['type']] = types.get(e['event']['type'], 0) + 1
        bundle.jsonl(f'{prefix}/events.jsonl', events, events=len(events), eventUtf8Bytes=sum(len(x) + 1 for x in lines),
                     types=dict(sorted(types.items())), sessions=len(world.sessions))
    snapshot = {'directory': {'workspaces': rows['workspaces'], 'sessions': views, 'folders': rows['session-folders'],
                              'tags': rows['session-tags'], 'runners': rows['runners']}}
    size = len(encode(snapshot))
    if size >= CACHE_LIMIT:
        raise SystemExit(f'{bundle.name}: the directory is {size} bytes as the Android cache stores it, over {CACHE_LIMIT}')
    return {'cachedDirectoryBytes': size, 'cacheLimitBytes': CACHE_LIMIT,
            'sessions': {v: len(r) for v, r in views.items()}, 'workspaces': len(rows['workspaces']),
            'folders': len(rows['session-folders']), 'tags': len(rows['session-tags']), 'runners': len(rows['runners'])}


def session_routes(prefix='api'):
    return [
        ['GET', '/api/workspaces', 'file', f'{prefix}/workspaces.json'],
        ['GET', '/api/runners', 'file', f'{prefix}/runners.json'],
        ['GET', '/api/session-folders', 'file', f'{prefix}/session-folders.json'],
        ['GET', '/api/session-tags', 'file', f'{prefix}/session-tags.json'],
        ['GET', '/api/sessions/:id', 'record', {'file': f'{prefix}/session-details.jsonl', 'missing': 'session not found'}],
        ['GET', '/api/sessions/:id/approvals', 'json', []],
        ['GET', '/api/sessions/:id/turns', 'json', []],
        ['GET', '/api/sessions/:id/background', 'json', []],
    ]


def build_ds0():
    bundle = Bundle('DS0', SPEC['DS0'])
    worlds = [World('DS0', 'member@ds0.orbit.test', 'DS0 Member', 'MEMBER'),
              World('DS0', 'admin@ds0.orbit.test', 'DS0 Admin', 'ADMIN')]
    routes, per_account = [], {}
    for world in worlds:
        world.add_tags(0)  # an empty account still lists the seven system tags (SessionTagsService.ensureSystemTags)
        slug = world.email.split('@')[0]
        summary = directory_files(bundle, world, f'api/{slug}')
        per_account[world.email] = summary
        for method, pattern, kind, target in session_routes(f'api/{slug}') + business_routes(bundle, world, f'api/{slug}'):
            routes.append([method, pattern, kind, target, world.email])
    bundle.json('accounts.json', [account_entry(w, f"api/{w.email.split('@')[0]}") for w in worlds])
    bundle.json('routes.json', routes_by_account(routes))
    bundle.json('scenarios.json', {
        'cases': [
            {'case': 'signed out', 'how': 'A fresh install (or Sign out) shows the login page; set the server to the '
                                          'fixture with the Server dialog (triple-tap the logo).'},
            {'case': 'first sign-in', 'how': 'Sign in as member@ds0.orbit.test: an empty account (no workspace, '
                                             'session, task, project, wiki space or watch; the seven system tags).'},
            {'case': 'valid cache', 'how': 'Sign in, let the directory load, force-stop the app, then POST /__control '
                                           '{"unreachable":true} and cold-start it: what it draws comes from its cache. '
                                           '{"unreachable":false} brings the server back.'},
            {'case': 'expired token', 'how': 'POST /__control {"expireAccess":true}: every access token issued so far '
                                             'answers 401 "invalid token"; the app refreshes once and stays signed in.'},
            {'case': 'revoked permission', 'how': 'POST /__control {"disable":["member@ds0.orbit.test"]}: requests answer '
                                                  '401 "account disabled", the refresh answers 403 ACCOUNT_DISABLED and the '
                                                  'app signs out; signing in again shows the disabled sentence. '
                                                  '{"enable":[…]} undoes it.'},
            {'case': 'wrong server', 'how': 'Start the server with --decoy-port 18781 and reverse that port too: '
                                            'http://127.0.0.1:18781 answers HTML, so sign-in says the answer was not an '
                                            "Orbit sign-in; a port nothing listens on says it couldn't reach the server."},
            {'case': 'roles', 'how': 'admin@ds0.orbit.test (ADMIN) has Settings → Account → Admin listing both accounts; '
                                     'member@ds0.orbit.test (MEMBER) has no Admin row.'},
        ]})
    bundle.summary = {'accounts': [{'email': w.email, 'role': w.role, **per_account[w.email]} for w in worlds]}
    return bundle


def routes_by_account(routes):
    """One route per (method, pattern); a target that differs by account becomes {"byAccount": {email: target}}."""
    out, seen = [], {}
    for method, pattern, kind, target, email in routes:
        key = (method, pattern)
        if key not in seen:
            seen[key] = [method, pattern, kind, {'byAccount': {}}]
            out.append(seen[key])
        seen[key][3]['byAccount'][email] = target
    return out


def build_ds6():
    bundle = Bundle('DS6', SPEC['DS6'])
    world = World('DS6', 'owner@ds6.orbit.test', 'DS6 Owner', 'MEMBER')
    world.add_runners(1)
    world.add_workspaces(1)
    world.add_tags(0)
    files = ds6_files()
    attachments = []
    for path, mime, data, note in files:
        bundle.raw(path, data, mimeType=mime, **note)
    downloadable = [f for f in files if f[2] and f[0] != 'files/limits/file-25mib-plus-1.bin'
                    and f[0] != 'files/limits/image-5mib-plus-1.png' and f[0] != 'files/limits/image-5mib-plus-1.jpg']
    for n, (path, mime, data, note) in enumerate(downloadable):
        attachments.append({'id': uuid7(ANCHOR - 30 * DAY + n * MINUTE, 'attachment', path), 'file': path, 'mimeType': mime,
                            'fileName': path.rsplit('/', 1)[1], 'size': len(data), 'sha256': hashlib.sha256(data).hexdigest()})
    by_file = {a['file']: a for a in attachments}

    def refs(paths):
        return [{'id': by_file[p]['id'], 'mime': by_file[p]['mimeType'], 'name': by_file[p]['fileName']} for p in paths]
    pictures = [f[0] for f in files if f[0].startswith('files/images/')]
    docs = [f[0] for f in files if f[0].startswith('files/docs/')] + ['files/limits/file-25mib.bin']
    plan = {
        0: ('DS6 · Composer', 1, {}),
        1: ('DS6 · Gallery (20 pictures)', 4, {('attachments', t): refs(pictures[5 * t:5 * t + 5]) for t in range(4)}),
        2: ('DS6 · 20,000-character Markdown', 1, {('assistant', 0): markdown_20k()}),
        3: ('DS6 · Files to download', 1, {('attachments', 0): refs(docs)}),
    }
    for t in range(4):
        plan[1][2][('user', t)] = f'Pictures {5 * t + 1}–{5 * t + 5} of 20 (JPEG, PNG and WebP, 1440×2560).'
    plan[3][2][('user', 0)] = 'The documents and the 25 MiB file, to download (and to interrupt with interruptDownloads).'
    world.add_sessions((4, 0, 0), lambda i: plan[i][1], 2, pinned=0, span_days=20,
                       titles={i: plan[i][0] for i in plan}, extra=lambda i: plan[i][2],
                       statuses={i: ('AWAITING_INPUT', None, None) for i in plan})
    summary = directory_files(bundle, world)
    bundle.jsonl('api/attachments.jsonl', [wire(dict(a)) for a in attachments], rows=len(attachments))
    bundle.json('inputs.json', {
        'imeComposition': IME_SEQUENCES,
        'longDraft': long_draft(),
        'markdown20k': markdown_20k(),
        'uploadContract': {'maxImageBytes': MAX_IMAGE, 'maxFileBytes': MAX_FILE, 'emptyFile': 'refused',
                           'source': 'apiserver AttachmentsController (multer fileSize); Android AttachmentLimits; '
                                     'OrbitKit Composer.maxImageBytes/maxFileBytes'},
    })
    bundle.json('accounts.json', [account_entry(world)])
    bundle.json('routes.json', session_routes() + business_routes(bundle, world, 'api'))
    bundle.json('scenarios.json', {
        'composerSession': base62(world.sessions[0]['id']),
        'cases': [
            {'case': 'upload limits', 'how': 'adb push the files/limits/ files to the device, attach them from storage: '
                                             'the 5 MiB images and the 25 MiB file are accepted, the +1 byte ones and the '
                                             'empty file are refused by the client; the server answers 413/400 the same way '
                                             'if a client sends them anyway.'},
            {'case': 'send before an upload finishes / cancel / process death', 'how': 'POST /__control '
                                             '{"uploadDelayMs":250} slows uploads to 250 ms per 64 KiB, long enough to send, '
                                             'cancel or kill the app mid-upload.'},
            {'case': 'download interrupted and retried', 'how': 'POST /__control {"interruptDownloads":1}: the next '
                                             'attachment download stops half way; the retry gets the whole file.'},
            {'case': 'Chinese composition, long draft, 20k Markdown', 'how': 'inputs.json: pinyin sequences, a 6,000-character '
                                             'draft, and the 20,000-character Markdown (also the reply in "DS6 · 20,000-character '
                                             'Markdown").'},
        ]})
    bundle.summary = {**summary, 'uploadFiles': len(files), 'attachments': len(attachments),
                      'pictures': len(pictures), 'markdownCharacters': 20_000}
    return bundle


def search_answers(world, words):
    """GET /sessions/search's answers for the dataset's fixed words, as the server would answer them."""
    return wire({word: world.search(word) for word in words})


def ds1_world():
    """DS1's rows before they are rendered: what build_ds1 writes, and what stack.py seeds a real server with."""
    world = World('DS1', 'owner@ds1.orbit.test', 'DS1 Owner', 'ADMIN')
    world.add_runners()
    world.add_workspaces(20)
    world.add_tags(4)
    world.add_folders(3, 2)
    missing = {kind: uuid7(ANCHOR - 10 * DAY, 'deleted', 'DS1', kind) for kind in ('session', 'task', 'project', 'list', 'wiki')}
    links = ('The objects below were deleted after this reply was written; each link opens to "no longer available".\n\n'
             + ''.join(f'- [Deleted {kind}](orbit-{kind}:{base62(uuid)})\n' for kind, uuid in missing.items()))
    plan = {0: ('DS1 · Links to deleted objects', {('assistant', 9): links}),
            1: ('DS1 · Load failure (its transcript answers 500)', {})}
    world.add_sessions((140, 45, 15), 10, 8, pinned=5, span_days=90, titles={i: plan[i][0] for i in plan},
                       extra=lambda i: plan[i][1] if i in plan else None,
                       statuses={0: ('AWAITING_INPUT', None, None), 1: ('AWAITING_INPUT', None, None)})
    world.add_task_lists(3)
    world.add_projects(20, done=4, cancelled=2)
    world.add_tasks(100)
    world.add_wiki(100, spaces=2)
    world.add_watches(20)
    return world, missing


def build_ds1():
    bundle = Bundle('DS1', SPEC['DS1'])
    world, missing = ds1_world()
    summary = directory_files(bundle, world)
    routes = session_routes() + business_routes(bundle, world, 'api')
    failing_task = sorted(world.tasks, key=lambda t: t['created'])[0]
    failing_project = sorted(world.projects, key=lambda p: p['created'])[-1]
    failures = [{'method': 'GET', 'path': f"/api/sessions/{base62(world.sessions[1]['id'])}/events/page", 'status': 500},
                {'method': 'GET', 'path': f"/api/tasks/{base62(failing_task['id'])}", 'status': 500},
                {'method': 'GET', 'path': f"/api/projects/{base62(failing_project['id'])}", 'status': 500}]
    failures += wiki_watch_failures(world)
    words = ['', 'zz-no-results', 'Fix', 'runner', '会话']
    bundle.json('api/sessions-search.json', search_answers(world, words))
    bundle.json('accounts.json', [account_entry(world)])
    bundle.json('routes.json', routes)
    bundle.json('scenarios.json', {
        'noResults': {'word': 'zz-no-results', 'where': ['GET /api/sessions/search?q=', 'GET /api/tasks/page?q=',
                                                          'GET /api/wiki/search?q=']},
        'failures': failures,
        'deletedLinks': {'session': base62(world.sessions[0]['id']),
                         'targets': {kind: base62(uuid) for kind, uuid in missing.items()}},
        'searchWords': {w: world.search(w)['total'] for w in words},
        'cases': [
            {'case': 'no results', 'how': 'Search "zz-no-results" in the session palette, Tasks and Wiki: nothing is found.'},
            {'case': 'load failure', 'how': 'The listed GETs always answer 500 (turn off with POST /__control '
                                            '{"failures":false}): "DS1 · Load failure" cannot open its transcript, and one '
                                            'task and one project cannot open.'},
            {'case': 'deep links to deleted objects', 'how': 'Open "DS1 · Links to deleted objects": its last reply links a '
                                                             'session, task, project, list and wiki entry that no longer exist (404).'},
        ]})
    bundle.summary = {**summary, 'eventsPerSession': 200, 'tasks': len(world.tasks), 'taskLists': len(world.lists),
                      'projects': len(world.projects), **world_counts(world)}
    return bundle


def build_ds2():
    bundle = Bundle('DS2', SPEC['DS2'])
    world = World('DS2', 'owner@ds2.orbit.test', 'DS2 Owner', 'MEMBER')
    world.add_runners()
    world.add_workspaces(20)
    world.add_tags(8)
    world.add_folders(5, 5)
    words = {'alpha': 40, '部署': 25, 'zeta-77': 1}
    titles, n = {}, 10
    for word, count in words.items():
        for _ in range(count):
            titles[n] = f"{title_of('ds2', n)} · {word}"
            n += 29  # spread over Open and Completed (indexes below 1,900), never in one run
    # Transcripts at the event pages' edges: tail pages are 200, after= pages 200 (RealtimeRest.page).
    edges = {2: 199, 3: 200, 4: 201, 5: 401}
    for i, count in edges.items():
        titles[i] = f'DS2 · {count} events'
    statuses = {i: ('AWAITING_INPUT', None, None) for i in edges}

    def turns(i):
        return {199: 20, 200: 20, 201: 20, 401: 40}.get(edges.get(i), 2)

    def extra(i):
        count = edges.get(i)
        if count in (199, 201, 401):
            return {('no-intro', turns(i) - 1): True}  # the last turn without its opening reply: an odd count
        return None

    def pairs_for(i):
        count = edges.get(i)
        return (lambda t: 4 if t == turns(i) - 1 else 3) if count in (201, 401) else 3
    world.add_sessions((1400, 500, 100), turns, pairs_for, pinned=12, span_days=180, titles=titles, extra=extra,
                       statuses=statuses)
    world.add_task_lists(8)
    world.add_projects(100, done=20, cancelled=10)
    world.add_tasks(2000, keywords={'kestrel': 120, '迁移': 30, 'zeta-77': 1}, ties=(198, 199, 200, 201))
    world.add_wiki(500, spaces=3)
    world.add_watches(100)
    summary = directory_files(bundle, world)
    routes = session_routes() + business_routes(bundle, world, 'api')
    search_words = ['', 'alpha', '部署', 'zeta-77', 'nohit-ds2']
    bundle.json('api/sessions-search.json', search_answers(world, search_words))
    # Permission change: one workspace (and everything in it) is no longer the reader's.
    revoked = world.workspaces[7]
    kept = [r for r in wire(world.workspace_rows()) if r['id'] != base62(revoked['id'])]
    bundle.json('api/permission/workspaces.json', kept, rows=len(kept))
    routes = [r if r[1] != '/api/workspaces' else ['GET', '/api/workspaces', 'file',
              {'default': 'api/workspaces.json', 'when': {'revokedWorkspace': 'api/permission/workspaces.json'}}] for r in routes]
    forbidden = [f"/api/sessions/{base62(s['id'])}" for s in world.sessions if s['workspace'] is revoked]
    # Bulk status change: the 200 most recently active open sessions are completed, the 300 oldest open tasks done.
    after = bulk_change(world)
    bundle.json('api/bulk/sessions-open.json', after['open'], rows=len(after['open']))
    bundle.json('api/bulk/sessions-completed.json', after['completed'], rows=len(after['completed']))
    bundle.jsonl('api/bulk/session-details.jsonl', after['details'], rows=len(after['details']))
    bundle.jsonl('api/bulk/tasks.jsonl', after['tasks'], rows=len(after['tasks']))
    bundle.jsonl('api/bulk/task-details.jsonl', after['taskDetails'], rows=len(after['taskDetails']))
    routes = [bulk_route(r) for r in routes]
    tie = sorted(world.tasks, key=lambda t: (t['created'], t['id']), reverse=True)[198:202]
    bundle.json('accounts.json', [account_entry(world)])
    bundle.json('routes.json', routes)
    bundle.json('scenarios.json', {
        'searchWords': {w: world.search(w)['total'] for w in search_words},
        'taskWords': {w: sum(1 for t in world.tasks if w in t['title']) for w in ['kestrel', '迁移', 'zeta-77', 'nohit-ds2']},
        'pageEdges': {'taskPage': {'limit': 200, 'tiedCreatedAt': iso(tie[0]['created']),
                                   'tiedTasks': [base62(t['id']) for t in tie],
                                   'note': 'positions 199–202 newest first share createdAt; the cursor breaks the tie by id'},
                      'eventPages': {f'{count} events': base62(world.sessions[i]['id']) for i, count in edges.items()}},
        'permissionChange': {'switch': 'revokedWorkspace', 'workspace': base62(revoked['id']),
                             'sessions': len(forbidden), 'forbiddenPaths': forbidden},
        'bulkStatusChange': {'switch': 'bulkStatus', 'sessionsCompleted': after['sessionCount'],
                             'tasksDone': after['taskCount'],
                             'files': {'open': 'api/bulk/sessions-open.json', 'completed': 'api/bulk/sessions-completed.json'}},
        'cases': [
            {'case': 'P01 valid local snapshot', 'how': 'Sign in once with the network up and let the directory load '
                                                        '(about 5.5 MB as cached), then force-stop and cold-start: the cached '
                                                        'directory is the fully-drawn content.'},
            {'case': 'fixed sort and search words', 'how': 'searchWords and taskWords give the expected totals; the list order '
                                                           'is the server\'s (pinned first, then last activity).'},
            {'case': 'page boundaries', 'how': 'Tasks page through 2,000 rows 200 at a time with a tie across positions '
                                               '199–202; the four "DS2 · N events" sessions sit on the event-page edges.'},
            {'case': 'permission change', 'how': 'POST /__control {"revokedWorkspace":true}: the workspace and its sessions '
                                                 'leave every list and its sessions answer 403; false restores them.'},
            {'case': 'bulk status change', 'how': 'POST /__control {"bulkStatus":true}: 200 open sessions move to Completed and '
                                                  '300 tasks become DONE at once, announced on /api/events.'},
        ]})
    bundle.summary = {**summary, 'tasks': len(world.tasks), 'taskLists': len(world.lists), 'projects': len(world.projects),
                      **world_counts(world)}
    return bundle


def bulk_route(route):
    method, pattern, kind, target = route
    if pattern == '/api/sessions/:id':
        return [method, pattern, kind, {**target, 'bulk': 'api/bulk/session-details.jsonl'}]
    if pattern == '/api/tasks/:id':
        return [method, pattern, kind, {**target, 'bulk': 'api/bulk/task-details.jsonl'}]
    return route


def bulk_change(world):
    """The rows as they read after DS2's bulk status change, rendered from changed copies of the records."""
    opened = sorted([s for s in world.sessions if s['view'] == 'open' and not s['pinnedAt']], key=lambda s: -s['lastTurn'])[:200]
    changed = []
    for s in opened:
        s['_saved'] = (s['view'], s['completedAt'])
        s['view'], s['completedAt'] = 'completed', ANCHOR + MINUTE
        changed.append(s)
    open_tasks = sorted([t for t in world.tasks if t['status'] == 'OPEN'], key=lambda t: t['created'])[:300]
    for t in open_tasks:
        t['_saved'] = (t['status'], t['updated'])
        t['status'], t['updated'] = 'DONE', ANCHOR + MINUTE
    out = {'open': wire(world.session_rows('open')), 'completed': wire(world.session_rows('completed')),
           'details': [], 'tasks': [], 'taskDetails': [], 'sessionCount': len(changed), 'taskCount': len(open_tasks)}
    for d in world.session_details():
        if any(d['id'] == s['id'] for s in changed):
            out['details'].append(wire(d))
    order = sorted(world.tasks, key=lambda t: (t['created'], t['id']), reverse=True)
    out['tasks'] = [wire(world.task_row(t)) for t in order]
    out['taskDetails'] = [wire(world.task_detail(t)) for t in open_tasks]
    for s in changed:
        s['view'], s['completedAt'] = s.pop('_saved')
    for t in open_tasks:
        t['status'], t['updated'] = t.pop('_saved')
    return out




BUILDERS = {'DS0': build_ds0, 'DS1': build_ds1, 'DS2': build_ds2, 'DS6': build_ds6}


# ---------------------------------------------------------------------------------------------- output

def git_blob(data):
    """`git hash-object` of a file: the id git gives these exact bytes, findable with `git log --find-object`."""
    return hashlib.sha1(b'blob %d\x00' % len(data) + data).hexdigest()


def generator_sources():
    out = []
    for name in SOURCES:
        data = (HERE / name).read_bytes()
        out.append({'path': f'src/android/scripts/qa/{name}', 'sha256': hashlib.sha256(data).hexdigest(),
                    'gitBlob': git_blob(data)})
    return out


class Bundle:
    """One dataset's files, written once and hashed as written."""

    def __init__(self, name, spec):
        self.name, self.spec = name, spec
        self.files = {}
        self.notes = {}  # path -> what the manifest says about the file beyond its size and hash
        self.summary = {}

    def json(self, path, value, **note):
        self.files[path] = encode(value) + b'\n'
        if note:
            self.notes[path] = note

    def jsonl(self, path, records, **note):
        self.files[path] = b''.join(encode(record) + b'\n' for record in records)
        if note:
            self.notes[path] = note

    def raw(self, path, data, **note):
        self.files[path] = data
        if note:
            self.notes[path] = note

    def manifest(self):
        files = []
        for path in sorted(self.files):
            data = self.files[path]
            files.append({'path': path, 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest(),
                          **self.notes.get(path, {})})
        return {'dataset': self.name, 'spec': self.spec, 'seed': SEED,
                'generator': {'name': GENERATOR, 'version': VERSION, 'sources': generator_sources()},
                'anchor': iso(ANCHOR), 'summary': self.summary, 'files': files}

    def write(self, root):
        folder = root / self.name
        for path, data in sorted(self.files.items()):
            target = folder / path
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
        (folder / 'manifest.json').write_bytes(json.dumps(self.manifest(), ensure_ascii=False, indent=1).encode() + b'\n')


def sums(root):
    lines = []
    for path in sorted(p for p in root.rglob('*') if p.is_file() and p.name != 'SHA256SUMS'):
        lines.append(f'{hashlib.sha256(path.read_bytes()).hexdigest()}  {path.relative_to(root).as_posix()}\n')
    return ''.join(lines)


def generate(root, names):
    root.mkdir(parents=True, exist_ok=True)
    stray = [p for p in root.iterdir() if p.name not in DATASETS and p.name != 'SHA256SUMS']
    if stray:
        raise SystemExit(f'{root} holds files that are not datasets: {", ".join(p.name for p in stray)}')
    for name in names:
        if (root / name).exists():
            raise SystemExit(f'{root / name} exists; generate into a new directory')
    for name in names:
        bundle = BUILDERS[name]()
        bundle.write(root)
        print(f'{name}: {len(bundle.files) + 1} files, {sum(map(len, bundle.files.values())):,} bytes', flush=True)
    (root / 'SHA256SUMS').write_text(sums(root))


def verify(root):
    written = (root / 'SHA256SUMS').read_text()
    now = sums(root)
    ok = written == now
    print('SHA256SUMS matches the files' if ok else 'SHA256SUMS does not match the files')
    pinned = PINNED.read_text() if PINNED.exists() else ''
    names = {line.split('  ', 1)[1].split('/', 1)[0] for line in now.splitlines()}
    expected = ''.join(line + '\n' for line in pinned.splitlines() if line.split('  ', 1)[1].split('/', 1)[0] in names)
    same = expected == now
    print(f'{PINNED.name} {"matches" if same else "does not match"} ({", ".join(sorted(names))})')
    return ok and same


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    commands = parser.add_subparsers(dest='command', required=True)
    make = commands.add_parser('generate', help='write the datasets into a new directory')
    make.add_argument('out', type=Path)
    make.add_argument('datasets', nargs='*', metavar='DATASET', help=f'any of {", ".join(DATASETS)} (default: all)')
    check = commands.add_parser('verify', help='re-hash a generated directory against SHA256SUMS and datasets.sha256')
    check.add_argument('out', type=Path)
    args = parser.parse_args()
    if args.command == 'generate':
        unknown = sorted(set(args.datasets) - set(DATASETS))
        if unknown:
            parser.error(f'unknown dataset {", ".join(unknown)}')
        generate(args.out, [d for d in DATASETS if d in args.datasets or not args.datasets])
    else:
        raise SystemExit(0 if verify(args.out) else 1)


if __name__ == '__main__':
    main()
