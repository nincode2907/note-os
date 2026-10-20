<?php

namespace Tests\Feature;

use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

class SyncPullContractTest extends TestCase
{
    use RefreshDatabase;

    private const DATASET = 'phase00-gate1-v1';

    public function test_initial_pull_returns_watermelon_contract_for_twenty_fixtures(): void
    {
        $fixtures = [];
        for ($index = 1; $index <= 20; $index++) {
            $fixtures[] = $this->note(sprintf('00000000-0000-4000-8000-%012d', $index), "Fixture {$index}");
        }

        $this->push(['created' => $fixtures, 'updated' => [], 'deleted' => []], 0)->assertNoContent();
        $payload = $this->pull();

        $this->assertGreaterThan(0, $payload->timestamp);
        $this->assertCount(20, $payload->changes->notes->created);
        $this->assertSame([], $payload->changes->notes->updated);
        $this->assertSame([], $payload->changes->notes->deleted);

        foreach ($payload->changes->notes->created as $index => $record) {
            $this->assertEqualsCanonicalizing(array_keys($this->note('id', 'title')), array_keys(get_object_vars($record)));
            $this->assertSame($fixtures[$index]['id'], $record->id);
            $this->assertSame(self::DATASET, $record->dataset_id);
            $this->assertSame('PRIVATE_SERVER', $record->privacy);
            $this->assertIsString($record->title);
            $this->assertIsString($record->body);
            $this->assertIsInt($record->revision);
            $this->assertFalse($record->deleted);
        }
    }

    public function test_initial_pull_with_zero_fixtures_returns_empty_change_sets(): void
    {
        $payload = $this->pull();

        $this->assertSame(0, $payload->timestamp);
        $this->assertSame([], $payload->changes->notes->created);
        $this->assertSame([], $payload->changes->notes->updated);
        $this->assertSame([], $payload->changes->notes->deleted);
    }

    public function test_incremental_pull_without_deletions_returns_updated_collection(): void
    {
        $id = '00000000-0000-4000-8000-000000000101';
        $this->push(['created' => [$this->note($id, 'Before')], 'updated' => [], 'deleted' => []], 0)->assertNoContent();
        $this->push(['created' => [], 'updated' => [$this->note($id, 'After')], 'deleted' => []], 1)->assertNoContent();

        $payload = $this->pull(1);

        $this->assertSame(2, $payload->timestamp);
        $this->assertSame([], $payload->changes->notes->created);
        $this->assertCount(1, $payload->changes->notes->updated);
        $this->assertSame('After', $payload->changes->notes->updated[0]->title);
        $this->assertSame($id, $payload->changes->notes->updated[0]->id);
        $this->assertFalse($payload->changes->notes->updated[0]->deleted);
        $this->assertSame([], $payload->changes->notes->deleted);
    }

    public function test_incremental_pull_returns_tombstones_as_deleted_ids(): void
    {
        $id = '00000000-0000-4000-8000-000000000102';
        $this->push(['created' => [$this->note($id, 'Delete me')], 'updated' => [], 'deleted' => []], 0)->assertNoContent();
        $this->push(['created' => [], 'updated' => [], 'deleted' => [$id]], 1)->assertNoContent();

        $payload = $this->pull(1);

        $this->assertSame(2, $payload->timestamp);
        $this->assertSame([], $payload->changes->notes->created);
        $this->assertSame([], $payload->changes->notes->updated);
        $this->assertSame([$id], $payload->changes->notes->deleted);
    }

    private function push(array $notes, int $lastPulledAt)
    {
        return $this->postJson('/api/sync', [
            'changes' => ['notes' => $notes],
            'lastPulledAt' => $lastPulledAt,
        ]);
    }

    private function pull(int $lastPulledAt = 0): object
    {
        $response = $this->getJson('/api/sync?dataset_id=' . self::DATASET . '&last_pulled_at=' . $lastPulledAt)
            ->assertOk();
        $payload = json_decode($response->getContent(), false, 512, JSON_THROW_ON_ERROR);

        $this->assertIsObject($payload);
        $this->assertEqualsCanonicalizing(['changes', 'timestamp'], array_keys(get_object_vars($payload)));
        $this->assertIsInt($payload->timestamp);
        $this->assertGreaterThanOrEqual(0, $payload->timestamp);
        $this->assertIsObject($payload->changes);
        $this->assertSame(['notes'], array_keys(get_object_vars($payload->changes)));
        $this->assertIsObject($payload->changes->notes);
        $this->assertEqualsCanonicalizing(['created', 'updated', 'deleted'], array_keys(get_object_vars($payload->changes->notes)));
        $this->assertIsArray($payload->changes->notes->created);
        $this->assertIsArray($payload->changes->notes->updated);
        $this->assertIsArray($payload->changes->notes->deleted);

        return $payload;
    }

    private function note(string $id, string $title): array
    {
        return [
            'id' => $id,
            'title' => $title,
            'body' => json_encode(['schemaVersion' => 1, 'type' => 'doc', 'content' => []], JSON_THROW_ON_ERROR),
            'privacy' => 'PRIVATE_SERVER',
            'dataset_id' => self::DATASET,
            'revision' => 0,
            'deleted' => false,
        ];
    }
}
