<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration {
    public function up(): void
    {
        Schema::create('sync_clock', function (Blueprint $table) {
            $table->unsignedTinyInteger('id')->primary();
            $table->unsignedBigInteger('revision')->default(0);
        });
        DB::table('sync_clock')->insert(['id' => 1, 'revision' => 0]);
        Schema::create('notes', function (Blueprint $table) {
            $table->string('id', 64)->primary();
            $table->string('title')->default('');
            $table->longText('body')->default('');
            $table->string('privacy', 32)->default('PRIVATE_SERVER');
            $table->unsignedBigInteger('revision')->default(0)->index();
            $table->boolean('deleted')->default(false);
            $table->timestamps(3);
        });
        Schema::create('sync_changes', function (Blueprint $table) {
            $table->unsignedBigInteger('revision')->primary();
            $table->string('note_id', 64)->index();
            $table->string('operation', 16);
            $table->json('payload')->nullable();
        });
        Schema::create('sync_mutations', function (Blueprint $table) {
            $table->string('mutation_id', 64)->primary();
            $table->json('result');
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('sync_mutations');
        Schema::dropIfExists('sync_changes');
        Schema::dropIfExists('notes');
        Schema::dropIfExists('sync_clock');
    }
};
