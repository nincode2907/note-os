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
    return DB::transaction(function () use ($since) {
        $clock = DB::table('sync_clock')->where('id', 1)->lockForUpdate()->first();
        $timestamp = (int) $clock->revision;
        $logs = DB::table('sync_changes')->where('revision', '>', $since)->where('revision', '<=', $timestamp)->orderBy('revision')->get();
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
    return DB::transaction(function () use ($notes, $body) {
        DB::table('sync_clock')->where('id', 1)->lockForUpdate()->first();
        $ids = array_merge(array_column($notes['created'] ?? [], 'id'), array_column($notes['updated'] ?? [], 'id'), $notes['deleted'] ?? []);
        foreach (array_unique($ids) as $id) {
            $current = DB::table('notes')->where('id', $id)->first();
            if ($current && (int) $current->revision > $body['lastPulledAt'] && !in_array($id, array_column($notes['created'] ?? [], 'id'), true)) abort(409, 'Conflict: remote note changed after pull');
        }
        foreach ($notes['created'] ?? [] as $row) {
            $id = $row['id'];
            $existing = DB::table('notes')->where('id', $id)->first();
            if ($existing) {
                DB::table('notes')->where('id', $id)->update(['title' => $row['title'] ?? '', 'body' => $row['body'] ?? '', 'privacy' => 'PRIVATE_SERVER', 'deleted' => false]);
                $op = 'updated';
            } else {
                DB::table('notes')->insert(['id' => $id, 'title' => $row['title'] ?? '', 'body' => $row['body'] ?? '', 'privacy' => 'PRIVATE_SERVER', 'created_at' => now(), 'updated_at' => now()]);
                $op = 'created';
            }
            recordNoteChange($id, $op, ['id' => $id, 'title' => $row['title'] ?? '', 'body' => $row['body'] ?? '', 'privacy' => 'PRIVATE_SERVER']);
        }
        foreach ($notes['updated'] ?? [] as $row) {
            $id = $row['id'];
            $existing = DB::table('notes')->where('id', $id)->first();
            $values = ['title' => $row['title'] ?? '', 'body' => $row['body'] ?? '', 'privacy' => 'PRIVATE_SERVER', 'deleted' => false, 'updated_at' => now()];
            if ($existing) DB::table('notes')->where('id', $id)->update($values); else DB::table('notes')->insert($values + ['id' => $id, 'created_at' => now()]);
            recordNoteChange($id, $existing ? 'updated' : 'created', ['id' => $id, 'title' => $values['title'], 'body' => $values['body'], 'privacy' => 'PRIVATE_SERVER']);
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
    $body = $request->validate(['mutationId' => 'required|string|max:64', 'note' => 'required|array', 'note.id' => 'required|string|max:64', 'note.title' => 'required|string', 'note.body' => 'required|string', 'note.deleted' => 'sometimes|boolean']);
    return DB::transaction(function () use ($body) {
        DB::table('sync_clock')->where('id', 1)->lockForUpdate()->first();
        $saved = DB::table('sync_mutations')->where('mutation_id', $body['mutationId'])->first();
        if ($saved) return response()->json(json_decode($saved->result, true));
        $note = $body['note']; $id = $note['id'];
        $existing = DB::table('notes')->where('id', $id)->first();
        $result = ['ok' => true, 'current' => $existing ? ['id' => $id, 'title' => $existing->title, 'body' => $existing->body, 'deleted' => (bool) $existing->deleted] : null];
        if ($existing) DB::table('notes')->where('id', $id)->update(['title' => $note['title'], 'body' => $note['body'], 'deleted' => (bool) ($note['deleted'] ?? false), 'updated_at' => now()]);
        else DB::table('notes')->insert(['id' => $id, 'title' => $note['title'], 'body' => $note['body'], 'privacy' => 'PRIVATE_SERVER', 'deleted' => (bool) ($note['deleted'] ?? false), 'created_at' => now(), 'updated_at' => now()]);
        recordNoteChange($id, ($note['deleted'] ?? false) ? 'deleted' : ($existing ? 'updated' : 'created'), ($note['deleted'] ?? false) ? null : ['id' => $id, 'title' => $note['title'], 'body' => $note['body'], 'privacy' => 'PRIVATE_SERVER']);
        DB::table('sync_mutations')->insert(['mutation_id' => $body['mutationId'], 'result' => json_encode($result)]);
        return response()->json($result);
    });
});
