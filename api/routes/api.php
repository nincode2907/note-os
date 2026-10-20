<?php

use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Route;

Route::get('/health', fn () => response()->json(['status' => 'ok']));

function nextRevision(): int
{
    $clock = DB::table('sync_clock')->where('id', 1)->lockForUpdate()->first();
    $revision = (int) $clock->revision + 1;
    DB::table('sync_clock')->where('id', 1)->update(['revision' => $revision]);
    return $revision;
}

function recordNoteChange(string $id, string $operation, ?array $payload): int
{
    $revision = nextRevision();
    DB::table('notes')->where('id', $id)->update(['revision' => $revision, 'updated_at' => now()]);
    DB::table('sync_changes')->insert(['revision' => $revision, 'note_id' => $id, 'operation' => $operation, 'payload' => $payload ? json_encode($payload) : null]);
    return $revision;
}

Route::get('/sync', function (Request $request) {
    $since = max(0, (int) $request->query('last_pulled_at', 0));
    $datasetId = $request->query('dataset_id');
    return DB::transaction(function () use ($since, $datasetId) {
        $clock = DB::table('sync_clock')->where('id', 1)->lockForUpdate()->first();
        $timestamp = (int) $clock->revision;
        $logs = DB::table('sync_changes')->where('sync_changes.revision', '>', $since)->where('sync_changes.revision', '<=', $timestamp)
            ->when($datasetId !== null, fn ($query) => $query->join('notes', 'notes.id', '=', 'sync_changes.note_id')->where('notes.dataset_id', $datasetId))
            ->select('sync_changes.*')->orderBy('sync_changes.revision')->get();
        $byNote = [];
        foreach ($logs as $log) {
            $item = $byNote[$log->note_id] ?? ['wasCreated' => false, 'latest' => null];
            $item['wasCreated'] = $item['wasCreated'] || $log->operation === 'created';
            $item['latest'] = $log;
            $byNote[$log->note_id] = $item;
        }
        $created = $updated = $deleted = [];
        foreach ($byNote as $item) {
            $change = $item['latest'];
            if ($change->operation === 'deleted') { $deleted[] = $change->note_id; continue; }
            $note = json_decode($change->payload, true);
            if ($item['wasCreated']) $created[] = $note; else $updated[] = $note;
        }
        return ['timestamp' => $timestamp, 'changes' => ['notes' => compact('created', 'updated', 'deleted')]];
    });
});

Route::post('/sync', function (Request $request) {
    $body = $request->validate(['changes' => 'required|array', 'lastPulledAt' => 'required|integer|min:0']);
    $notes = $body['changes']['notes'] ?? [];
    foreach (array_merge($notes['created'] ?? [], $notes['updated'] ?? []) as $row) {
        if (($row['privacy'] ?? 'PRIVATE_SERVER') !== 'PRIVATE_SERVER') abort(422, 'Only PRIVATE_SERVER notes may sync to this server');
    }
    return DB::transaction(function () use ($notes, $body) {
        DB::table('sync_clock')->where('id', 1)->lockForUpdate()->first();
        $ids = array_merge(array_column($notes['created'] ?? [], 'id'), array_column($notes['updated'] ?? [], 'id'), $notes['deleted'] ?? []);
        foreach (array_unique($ids) as $id) {
            $current = DB::table('notes')->where('id', $id)->first();
            $isCreate = in_array($id, array_column($notes['created'] ?? [], 'id'), true);
            if ($current && (int) $current->revision > $body['lastPulledAt'] && !$isCreate) {
                abort(response()->json(['message' => 'Conflict: remote note changed after the client base revision', 'current' => ['id' => $current->id, 'title' => $current->title, 'body' => $current->body, 'deleted' => (bool) $current->deleted, 'revision' => (int) $current->revision]], 409));
            }
        }
        foreach ($notes['created'] ?? [] as $row) {
            $id = $row['id'];
            $existing = DB::table('notes')->where('id', $id)->first();
            if ($existing) {
                $title = $row['title'] ?? '';
                $bodyText = $row['body'] ?? '';
                if ($existing->deleted || $existing->title !== $title || $existing->body !== $bodyText) {
                    abort(response()->json(['message' => 'Conflict: create replay differs from current note or would resurrect a deletion', 'current' => ['id' => $existing->id, 'title' => $existing->title, 'body' => $existing->body, 'deleted' => (bool) $existing->deleted, 'revision' => (int) $existing->revision]], 409));
                }
                continue;
            }
            $dataset = $row['dataset_id'] ?? '';
            DB::table('notes')->insert(['id' => $id, 'title' => $row['title'] ?? '', 'body' => $row['body'] ?? '', 'privacy' => 'PRIVATE_SERVER', 'dataset_id' => $dataset, 'created_at' => now(), 'updated_at' => now()]);
            recordNoteChange($id, 'created', ['id' => $id, 'title' => $row['title'] ?? '', 'body' => $row['body'] ?? '', 'privacy' => 'PRIVATE_SERVER', 'dataset_id' => $dataset]);
        }
        foreach ($notes['updated'] ?? [] as $row) {
            $id = $row['id'];
            $existing = DB::table('notes')->where('id', $id)->first();
            $values = ['title' => $row['title'] ?? '', 'body' => $row['body'] ?? '', 'privacy' => 'PRIVATE_SERVER', 'dataset_id' => $row['dataset_id'] ?? ($existing->dataset_id ?? ''), 'deleted' => false, 'updated_at' => now()];
            if ($existing) DB::table('notes')->where('id', $id)->update($values); else DB::table('notes')->insert($values + ['id' => $id, 'created_at' => now()]);
            recordNoteChange($id, $existing ? 'updated' : 'created', ['id' => $id, 'title' => $values['title'], 'body' => $values['body'], 'privacy' => 'PRIVATE_SERVER', 'dataset_id' => $values['dataset_id']]);
        }
        foreach ($notes['deleted'] ?? [] as $id) {
            $existing = DB::table('notes')->where('id', $id)->first();
            if ($existing && !$existing->deleted) {
                DB::table('notes')->where('id', $id)->update(['deleted' => true]);
                recordNoteChange($id, 'deleted', null);
            }
        }
        return response()->noContent();
    });
});

Route::post('/delta/push', function (Request $request) {
    $body = $request->validate(['mutationId' => 'required|string|max:64', 'baseRevision' => 'required|integer|min:0', 'note' => 'required|array', 'note.id' => 'required|string|max:64', 'note.title' => 'required|string', 'note.body' => 'required|string', 'note.privacy' => 'required|in:PRIVATE_SERVER', 'note.dataset_id' => 'sometimes|string|max:64', 'note.deleted' => 'sometimes|boolean']);
    return DB::transaction(function () use ($body) {
        DB::table('sync_clock')->where('id', 1)->lockForUpdate()->first();
        $saved = DB::table('sync_mutations')->where('mutation_id', $body['mutationId'])->first();
        $intentHash = hash('sha256', json_encode($body['note'], JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE));
        if ($saved) {
            $stored = json_decode($saved->result, true);
            if (!isset($stored['intentHash'], $stored['response']) || !hash_equals($stored['intentHash'], $intentHash)) abort(409, 'Mutation ID was already used for a different payload');
            return response()->json($stored['response']);
        }
        $note = $body['note']; $id = $note['id'];
        $existing = DB::table('notes')->where('id', $id)->first();
        if ($existing && ((int) $existing->revision > $body['baseRevision'] || ($existing->deleted && !($note['deleted'] ?? false)))) {
            abort(response()->json(['message' => 'Conflict: server note changed after the client base revision', 'current' => ['id' => $id, 'title' => $existing->title, 'body' => $existing->body, 'deleted' => (bool) $existing->deleted, 'revision' => (int) $existing->revision]], 409));
        }
        $current = $existing ? ['id' => $id, 'title' => $existing->title, 'body' => $existing->body, 'deleted' => (bool) $existing->deleted, 'revision' => (int) $existing->revision] : null;
        $datasetId = $note['dataset_id'] ?? ($existing->dataset_id ?? '');
        if ($existing) DB::table('notes')->where('id', $id)->update(['title' => $note['title'], 'body' => $note['body'], 'deleted' => (bool) ($note['deleted'] ?? false), 'updated_at' => now()]);
        else DB::table('notes')->insert(['id' => $id, 'title' => $note['title'], 'body' => $note['body'], 'privacy' => 'PRIVATE_SERVER', 'dataset_id' => $datasetId, 'deleted' => (bool) ($note['deleted'] ?? false), 'created_at' => now(), 'updated_at' => now()]);
        $revision = recordNoteChange($id, ($note['deleted'] ?? false) ? 'deleted' : ($existing ? 'updated' : 'created'), ($note['deleted'] ?? false) ? null : ['id' => $id, 'title' => $note['title'], 'body' => $note['body'], 'privacy' => 'PRIVATE_SERVER', 'dataset_id' => $datasetId]);
        $result = ['ok' => true, 'current' => $current, 'revision' => $revision];
        DB::table('sync_mutations')->insert(['mutation_id' => $body['mutationId'], 'result' => json_encode(['intentHash' => $intentHash, 'response' => $result])]);
        return response()->json($result);
    });
});
