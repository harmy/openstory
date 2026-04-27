# Managing complex dependency graphs in collaborative AI video platforms

The most effective architecture for your use case combines **immutable snapshots with version chains**, **content-hash based invalidation**, **Linear-style transaction sync**, and **explicit state machines** for lifecycle management. Full event sourcing is overkill here—a pragmatic hybrid achieves version control and branching without the operational complexity. This approach handles the critical requirement of isolating long-running workflows from concurrent edits while maintaining a clear audit trail and supporting Vercel-style "pending changes" indicators.

## The core architectural pattern: versioned DAG with workflow snapshots

Your entity hierarchy (script → scenes → cast/characters → frames → motion) forms a directed acyclic graph where each node carries a **content hash** and **version number**. When a workflow starts, it captures a **snapshot reference** containing the version numbers of all input entities. This decouples running workflows from live edits entirely.

The key insight from build systems like Bazel and incremental computation frameworks like Salsa is that staleness detection should compare **content hashes**, not timestamps. Each entity stores a `contentHash` (SHA-256 of its data) and each generated output records `generatedFromInputHash`—the hash of all input hashes when generation started. Checking staleness becomes a single comparison: `currentInputHash !== generatedFromInputHash`.

```typescript
interface VersionedEntity<T> {
  id: string;
  version: number;
  contentHash: string; // SHA-256 of entity data
  parentVersion: number | null; // For branching/restore
  branchName: string; // 'main' by default
  data: Readonly<T>;
  createdAt: Date;
}

interface GenerationProvenance {
  entityId: string;
  inputHash: string; // Hash of dependency hashes
  inputVersions: Record<string, number>; // {"scene_id": 5, "cast_id": 3}
  generatedAt: Date;
  generatorVersion: string; // AI model version
}
```

This schema supports version history (query by version), branching (create new entity with `parentVersion` pointing to branch point), restoration (load specific version and set as current), and staleness detection (compare hashes).

## Dependency tracking and invalidation: lessons from build systems

Bazel's Skyframe architecture and rust-analyzer's Salsa framework both solve the same problem you face: determining what needs rebuilding when inputs change. Three patterns emerge as most applicable.

**Content-addressable staleness checking** provides instant dirty detection. Rather than walking the dependency graph on every change, each entity stores the hash of inputs used to generate it. When displaying UI or processing jobs, compute the current input hash and compare:

```typescript
function needsRegeneration(entity: Entity, graph: DependencyGraph): boolean {
  const provenance = getGenerationProvenance(entity.id);
  if (!provenance) return true; // Never generated

  const currentInputHash = computeInputHash(entity.id, graph);
  return provenance.inputHash !== currentInputHash;
}

function computeInputHash(entityId: string, graph: DependencyGraph): string {
  const deps = graph.getDependencies(entityId);
  const depHashes = deps
    .map((d) => d.contentHash)
    .sort()
    .join('');
  return sha256(depHashes);
}
```

**Lazy invalidation with dirty bits** (from Adapton) avoids cascading recomputation. When an entity changes, mark only its immediate dependents as "potentially stale"—don't propagate further until someone queries that entity. This is crucial for avoiding UI jank when users make rapid edits:

```typescript
async function onEntityUpdate(entityId: string, newContentHash: string) {
  // Update the entity
  await updateEntity(entityId, {
    contentHash: newContentHash,
    version: version + 1,
  });

  // Mark immediate dependents as potentially stale (don't cascade)
  const dependents = await getDependents(entityId);
  for (const dep of dependents) {
    await redis.sadd(`stale:pending:${dep}`, entityId);
  }

  // Broadcast for UI updates
  await redis.publish(
    'entity:changed',
    JSON.stringify({ entityId, version: version + 1 })
  );
}
```

**Topological ordering for regeneration queues** ensures dependencies are processed before dependents. When regenerating multiple stale entities, use Kahn's algorithm to order the work:

```typescript
function getRegenerationOrder(
  staleEntities: Set<string>,
  graph: DependencyGraph
): string[] {
  const inDegree = new Map<string, number>();
  for (const id of staleEntities) {
    const staleDeps = graph
      .getDependencies(id)
      .filter((d) => staleEntities.has(d.id));
    inDegree.set(id, staleDeps.length);
  }

  const queue = [...staleEntities].filter((id) => inDegree.get(id) === 0);
  const result: string[] = [];

  while (queue.length > 0) {
    const current = queue.shift()!;
    result.push(current);
    for (const dependent of graph.getDependents(current)) {
      if (staleEntities.has(dependent.id)) {
        const newDegree = (inDegree.get(dependent.id) ?? 0) - 1;
        inDegree.set(dependent.id, newDegree);
        if (newDegree === 0) queue.push(dependent.id);
      }
    }
  }
  return result;
}
```

## Collaborative editing without CRDTs: property-level last-writer-wins

For scene-level editing granularity, full CRDTs are overkill. Both Figma and Linear use simpler approaches that work well for structured data editing.

Figma models documents as `Map<ObjectID, Map<Property, Value>>` with **property-level last-writer-wins**. Two users editing different properties on the same scene causes no conflict. Two users editing the same property results in the last write to reach the server winning. This is intuitive for users and simple to implement.

Linear adds **transaction-based sync with rebasing**. All operations are packaged as transactions (Create, Update, Delete) with a `baseVersion`. When a transaction conflicts with server state, the client rebases—updating its local transaction's base to the new server state. This provides optimistic updates with reliable conflict resolution:

```typescript
interface Transaction {
  type: 'update';
  entityId: string;
  baseVersion: number; // Version client expected
  property: string;
  oldValue: any; // For rebasing
  newValue: any;
}

async function handleTransaction(tx: Transaction): Promise<TransactionResult> {
  const current = await getEntity(tx.entityId);

  if (current.version !== tx.baseVersion) {
    // Conflict - return current state for client to rebase
    return {
      success: false,
      currentVersion: current.version,
      currentValue: current.data[tx.property],
      shouldRebase: true,
    };
  }

  // Apply update
  const newVersion = current.version + 1;
  await updateEntity(tx.entityId, {
    data: { ...current.data, [tx.property]: tx.newValue },
    version: newVersion,
    contentHash: computeHash({ ...current.data, [tx.property]: tx.newValue }),
  });

  // Broadcast to all clients via Redis
  await redis.publish(
    `entity:${tx.entityId}`,
    JSON.stringify({
      type: 'update',
      property: tx.property,
      value: tx.newValue,
      version: newVersion,
      userId: tx.userId,
    })
  );

  return { success: true, version: newVersion };
}
```

**Recommendation**: Skip Yjs/Automerge unless you need character-level text collaboration or offline-first with extended offline periods. Property-level LWW with server-as-authority is simpler and sufficient for scene editing.

## Snapshot isolation for long-running workflows

PostgreSQL's MVCC provides snapshot isolation within transactions, but holding transactions open for minutes or hours causes connection pool exhaustion and blocks VACUUM. The solution is **application-level workflow snapshots**.

When a workflow starts, capture the current versions of all relevant entities into a snapshot table. The workflow reads exclusively from this snapshot, completely isolated from subsequent edits:

```sql
-- Workflow snapshots table
CREATE TABLE workflow_snapshots (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workflow_id UUID NOT NULL REFERENCES workflows(id),
    created_at TIMESTAMPTZ DEFAULT now(),
    entity_refs JSONB NOT NULL  -- {"scene_123": 5, "cast_456": 3}
);

-- Alternative: denormalized JSONB snapshot for faster reads
CREATE TABLE workflow_input_snapshots (
    id UUID PRIMARY KEY,
    content_hash BYTEA UNIQUE NOT NULL,  -- Content-addressable
    snapshot_data JSONB NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now()
);
```

The workflow start pattern captures everything needed:

```typescript
async function startWorkflow(
  workflowId: string,
  inputEntityIds: string[]
): Promise<WorkflowSnapshot> {
  const entities = await getEntities(inputEntityIds);

  // Capture current versions
  const entityRefs: Record<string, number> = {};
  const snapshotData: Record<string, any> = {};

  for (const entity of entities) {
    entityRefs[entity.id] = entity.version;
    snapshotData[entity.id] = structuredClone(entity.data);
  }

  // Compute content hash for deduplication
  const contentHash = sha256(JSON.stringify(snapshotData));

  // Store snapshot (content-addressable deduplication)
  await db.query(
    `
    INSERT INTO workflow_input_snapshots (id, content_hash, snapshot_data)
    VALUES ($1, $2, $3)
    ON CONFLICT (content_hash) DO NOTHING
  `,
    [workflowId, contentHash, snapshotData]
  );

  // Link workflow to snapshot
  await db.query(
    `
    UPDATE workflows SET 
      snapshot_id = $1,
      input_entity_refs = $2,
      status = 'running',
      started_at = now()
    WHERE id = $3
  `,
    [workflowId, entityRefs, workflowId]
  );

  return { workflowId, entityRefs, snapshotData };
}
```

**Content-addressable storage** (inspired by Git) provides automatic deduplication—if two workflows start with identical inputs, they share the same snapshot.

## State machines for entity lifecycle: valid → stale → regenerating

XState v5 provides the cleanest way to model entity lifecycle explicitly. The state machine makes invalid transitions impossible and persists to your database:

```typescript
import { createMachine, createActor, assign } from 'xstate';

const entityLifecycleMachine = createMachine({
  id: 'entityLifecycle',
  initial: 'valid',
  context: {
    entityId: '',
    generatedFromInputHash: null,
    currentInputHash: null,
    workflowId: null,
  },
  states: {
    valid: {
      entry: 'clearStaleIndicators',
      on: {
        DEPENDENCY_CHANGED: {
          target: 'checking',
          actions: assign({
            currentInputHash: ({ event }) => event.newInputHash,
          }),
        },
      },
    },
    checking: {
      always: [
        { guard: 'inputHashUnchanged', target: 'valid' }, // Early cutoff
        { target: 'stale' },
      ],
    },
    stale: {
      entry: 'notifyStaleStatus',
      on: {
        REGENERATION_REQUESTED: { target: 'queued' },
        DEPENDENCY_CHANGED: { actions: 'updateInputHash' }, // Stay stale, update hash
      },
    },
    queued: {
      on: {
        WORKER_CLAIMED: {
          target: 'regenerating',
          actions: assign({ workflowId: ({ event }) => event.workflowId }),
        },
        DEPENDENCY_CHANGED: {
          target: 'stale', // Back to stale, will need re-queue
          actions: 'updateInputHash',
        },
      },
    },
    regenerating: {
      on: {
        GENERATION_COMPLETE: {
          target: 'valid',
          actions: assign({
            generatedFromInputHash: ({ context }) => context.currentInputHash,
            workflowId: null,
          }),
        },
        GENERATION_FAILED: { target: 'stale' },
        DEPENDENCY_CHANGED: {
          // Mark as "stale during generation" - will need re-run
          actions: ['updateInputHash', 'markRegenerationStale'],
        },
      },
    },
  },
});
```

**Persisting state machine state** to PostgreSQL:

```typescript
// On every state transition
entityActor.subscribe(async (snapshot) => {
  await db.query(
    `
    UPDATE entities SET 
      lifecycle_state = $1,
      state_context = $2,
      updated_at = now()
    WHERE id = $3
  `,
    [snapshot.value, snapshot.context, snapshot.context.entityId]
  );

  // Broadcast for real-time UI
  await redis.publish(
    'entity:lifecycle',
    JSON.stringify({
      entityId: snapshot.context.entityId,
      state: snapshot.value,
      isStale: ['stale', 'queued', 'regenerating'].includes(snapshot.value),
    })
  );
});
```

## PostgreSQL schema for the complete system

This schema supports versioning, branching, dependency tracking, and workflow snapshots:

```sql
-- Versioned entities with branching support
CREATE TABLE entity_versions (
    id UUID DEFAULT gen_random_uuid(),
    entity_id UUID NOT NULL,
    version INTEGER NOT NULL,
    branch_name VARCHAR(100) DEFAULT 'main',
    parent_version INTEGER,              -- For branching
    content_hash VARCHAR(64) NOT NULL,   -- SHA-256
    data JSONB NOT NULL,
    entity_type VARCHAR(50) NOT NULL,    -- 'script', 'scene', 'cast', 'frame', 'motion'
    lifecycle_state VARCHAR(50) DEFAULT 'valid',
    created_by UUID,
    created_at TIMESTAMPTZ DEFAULT now(),
    PRIMARY KEY (entity_id, branch_name, version)
);

-- Efficient lookups
CREATE INDEX idx_entity_current ON entity_versions(entity_id, branch_name)
    WHERE lifecycle_state != 'deleted';
CREATE INDEX idx_entity_content_hash ON entity_versions(content_hash);

-- Dependency graph edges
CREATE TABLE dependencies (
    dependent_id UUID NOT NULL,          -- Downstream entity
    dependency_id UUID NOT NULL,         -- Upstream entity
    dependency_type VARCHAR(50),         -- 'script_scene', 'scene_frame', etc.
    PRIMARY KEY (dependent_id, dependency_id)
);
CREATE INDEX idx_deps_upstream ON dependencies(dependency_id);

-- Generation provenance
CREATE TABLE generation_records (
    entity_id UUID PRIMARY KEY,
    input_hash VARCHAR(64) NOT NULL,
    input_versions JSONB NOT NULL,       -- {"scene_123": 5, "cast_456": 3}
    generator_version VARCHAR(50),
    generated_at TIMESTAMPTZ DEFAULT now(),
    output_artifact_url TEXT
);

-- Workflow snapshots (content-addressable)
CREATE TABLE workflow_snapshots (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    content_hash BYTEA UNIQUE NOT NULL,
    snapshot_data JSONB NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now()
);

-- Workflows
CREATE TABLE workflows (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    type VARCHAR(100) NOT NULL,
    status VARCHAR(50) DEFAULT 'pending',
    snapshot_id UUID REFERENCES workflow_snapshots(id),
    input_entity_refs JSONB,             -- {"scene_123": 5}
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    result JSONB,
    error TEXT
);

-- Job queue using SKIP LOCKED pattern
CREATE TABLE generation_queue (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    entity_id UUID NOT NULL,
    priority INTEGER DEFAULT 0,
    input_hash VARCHAR(64) NOT NULL,
    status VARCHAR(50) DEFAULT 'pending',
    claimed_by VARCHAR(100),
    claimed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX idx_queue_pending ON generation_queue(priority DESC, created_at)
    WHERE status = 'pending';
```

**Job queue with SKIP LOCKED** for worker distribution:

```sql
-- Worker claims next job (non-blocking)
WITH claimed AS (
    SELECT id FROM generation_queue
    WHERE status = 'pending'
    ORDER BY priority DESC, created_at
    LIMIT 1
    FOR UPDATE SKIP LOCKED
)
UPDATE generation_queue SET
    status = 'processing',
    claimed_by = $worker_id,
    claimed_at = now()
FROM claimed
WHERE generation_queue.id = claimed.id
RETURNING generation_queue.*;
```

## Handling the critical scenario: edits during generation

When User A edits Scene 3 while frames for Scene 5 are generating, the system needs clear behavior. Here's how the architecture handles it:

**Case 1: Scene 3 is not a dependency of Scene 5's frames**
No conflict. The edit proceeds normally. Scene 3's dependents are marked stale. Scene 5's generation completes and its result is applied.

**Case 2: Scene 3 is a dependency of Scene 5's frames**
The generation workflow captured a snapshot at start time, so it continues using the original Scene 3 data. When the edit arrives:

1. Scene 3's content hash updates, version increments
2. Invalidation propagates: Scene 5's frames marked as "stale" (via state machine)
3. Meanwhile, generation continues with snapshot data
4. Generation completes, but before applying:

```typescript
async function handleGenerationComplete(result: GenerationResult) {
  const currentInputHash = computeInputHash(result.entityId);

  if (result.inputHash === currentInputHash) {
    // Inputs unchanged - apply result
    await applyGeneration(result);
    await entityActor.send({ type: 'GENERATION_COMPLETE' });
  } else {
    // Inputs changed during generation
    // Options based on user preference:

    // Option A: Discard and re-queue (default for auto-regeneration)
    await entityActor.send({ type: 'GENERATION_STALE' });
    await queueRegeneration(result.entityId);

    // Option B: Apply as "alternate version" (for expensive generations)
    await saveAlternateVersion(result);
    await notifyUser('Generation completed with previous inputs');

    // Option C: Let user decide
    await saveForReview(result);
    await notifyUser('Review needed: inputs changed during generation');
  }
}
```

**UI indication** (Vercel-style "pending changes"):

```typescript
// Real-time UI state from Redis subscription
interface EntityUIState {
  entityId: string;
  lifecycleState: 'valid' | 'stale' | 'queued' | 'regenerating';
  generatedFromVersion: number;
  currentSourceVersion: number;
  hasPendingChanges: boolean; // generatedFromVersion !== currentSourceVersion
  generationProgress?: number;
}
```

## Workflow orchestration: Inngest for most cases

For your TypeScript + serverless-friendly stack, **Inngest** provides the best balance of capability and simplicity. It handles retries, concurrency limits, and step-based workflows without infrastructure management:

```typescript
import { Inngest } from 'inngest';

const inngest = new Inngest({ id: 'video-platform' });

export const generateFrames = inngest.createFunction(
  {
    id: 'generate-frames',
    retries: 3,
    concurrency: { limit: 5, key: 'event.data.userId' }, // Per-user throttling
  },
  { event: 'frame/generation.requested' },
  async ({ event, step }) => {
    // Step 1: Create snapshot
    const snapshot = await step.run('create-snapshot', async () => {
      return await startWorkflow(
        event.data.workflowId,
        event.data.inputEntityIds
      );
    });

    // Step 2: Generate frames (can be retried independently)
    const frames = await step.run('generate', async () => {
      return await aiService.generateFrames(snapshot.snapshotData);
    });

    // Step 3: Validate and apply (or discard if stale)
    await step.run('apply-result', async () => {
      const currentInputHash = computeInputHash(event.data.entityId);
      if (snapshot.contentHash === currentInputHash) {
        await applyGeneration(event.data.entityId, frames);
      } else {
        await markForReview(event.data.entityId, frames, snapshot);
      }
    });
  }
);
```

For mission-critical, potentially infinite workflows (like waiting for human approval for days), **Temporal.io** provides stronger durability guarantees but requires dedicated infrastructure.

## Redis integration patterns for real-time updates

Redis serves three purposes: pub/sub for real-time sync, ephemeral state for progress tracking, and rate limiting.

```typescript
// Real-time sync hub
class RealtimeSyncHub {
  constructor(
    private redis: Redis,
    private redisSub: Redis
  ) {
    this.setupSubscriptions();
  }

  private setupSubscriptions() {
    this.redisSub.psubscribe('entity:*', 'workflow:*');
    this.redisSub.on('pmessage', (pattern, channel, message) => {
      this.broadcastToClients(channel, JSON.parse(message));
    });
  }

  // Publish entity change from PostgreSQL trigger
  async publishEntityChange(entityId: string, change: EntityChange) {
    await this.redis.publish(
      `entity:${entityId}`,
      JSON.stringify({
        ...change,
        timestamp: Date.now(),
      })
    );
  }

  // Track generation progress (ephemeral, no DB persistence needed)
  async updateProgress(workflowId: string, progress: number) {
    await this.redis.hset(`workflow:${workflowId}:progress`, {
      percent: progress,
      updatedAt: Date.now(),
    });
    await this.redis.publish(
      'workflow:progress',
      JSON.stringify({
        workflowId,
        progress,
      })
    );
  }
}
```

**Bridge PostgreSQL LISTEN/NOTIFY to Redis** for change capture:

```typescript
// Listen to PostgreSQL notifications
const pgClient = new pg.Client(connectionString);
await pgClient.connect();
await pgClient.query('LISTEN entity_changes');

pgClient.on('notification', async (msg) => {
  const payload = JSON.parse(msg.payload);
  // Forward to Redis for fan-out to all server instances
  await redis.publish(`entity:${payload.entity_id}`, msg.payload);
});
```

## Summary of architectural decisions

| Decision Area                | Recommendation                        | Rationale                                                   |
| ---------------------------- | ------------------------------------- | ----------------------------------------------------------- |
| **Versioning approach**      | Immutable snapshots + version chains  | Full history, branching, fast queries without ES complexity |
| **Staleness detection**      | Content hash comparison               | O(1) check, inspired by Bazel/Git                           |
| **Invalidation propagation** | Lazy dirty bits + demand verification | Avoids cascading recomputation on rapid edits               |
| **Collaborative sync**       | Property-level LWW with transactions  | Simpler than CRDTs, sufficient for scene-level editing      |
| **Workflow isolation**       | Application-level snapshots           | Avoids long-running transaction issues                      |
| **Lifecycle management**     | XState state machines                 | Explicit states, persisted, impossible invalid transitions  |
| **Workflow orchestration**   | Inngest (or Temporal for critical)    | Durability + simplicity balance                             |
| **Real-time events**         | Redis pub/sub + PostgreSQL NOTIFY     | Proven pattern, horizontal scaling                          |
| **Job distribution**         | SKIP LOCKED queue pattern             | Non-blocking, high throughput                               |

This architecture handles your core requirements: multi-user editing with isolation, long-running workflows against stable snapshots, automatic invalidation tracking, version history with branching, and clear "pending changes" UX. Start with the core versioning schema and state machines, add collaborative sync, then layer in workflow orchestration as complexity grows.
