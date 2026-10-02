# Historical artifact storage: Git LFS and Xet investigation

Date: 2026-10-02.

Status: research recorded; implementation deferred until a larger representative
artifact history is available. No storage-format or client-protocol change is
approved by this document.

## Conclusion

Keep the current direct-delta/full-snapshot architecture. Standard Git LFS does
not offer a better history-compression mechanism. Xet-style content-defined
chunking (CDC) is feasible, but its exact-chunk reuse is not a replacement for
byte-level deltas: on the two distinct published `gm` binaries available for this
investigation, CDC required **49.4% more compressed historical payload**.

CDC won decisively on a synthetic relocation of existing content, but lost on
scattered small edits. Consider it again when real workloads demonstrate enough
unchanged, reusable regions across versions or files to offset metadata, read
fragmentation, and garbage-collection costs. One real revision transition is not
evidence about thousands of revisions.

The current design's most promising separate research direction is reuse across
frame boundaries while preserving byte-level deltas. That is a hypothesis to
benchmark, not an implemented improvement.

## Existing Gitmatrix design

The investigation examined the storage implementation at source commit
`aaf2afa0533c`:

- [Artifact codec](packages/formats/src/artifact-storage/index.ts): bounded
  raw/deflate compression and copy/literal delta instructions.
- [Compactor](apps/website/registry/core/blob-compaction.ts): anchor selection,
  staged encoding, verification, queue checkpoints, and fenced publication.
- [Historical reader](apps/website/registry/core/blob-storage.ts): immutable
  manifests, frame verification, range reconstruction, and physical deletion.
- [Blob API](apps/website/registry/core/blobs.ts): whole-file digest identity,
  streaming upload, deduplication, and HTTP download semantics.
- [Physical GC](apps/website/registry/jobs/gc.ts) and
  [storage migration](apps/website/registry/migrations/0004_artifact_storage.sql):
  generation lifetime, snapshot dependencies, and publication/hot-set tracking.
- [Storage documentation](apps/website/README.md#historical-artifact-storage).

The logical identity is the SHA-256 of the original whole file. Identical files
already share a logical blob across repositories and formats; authorization is
through repository-scoped attachments, not knowledge of that global digest.

The newest two distinct published versions in each lineage remain raw. Older
versions use independently compressed 4 MiB frames. Each delta refers directly
to a full snapshot, never to another delta. The compactor selects a new snapshot
at the 32nd update after its anchor, or earlier when total compressed delta
payload exceeds half the compressed full-version payload. Equality remains a
delta. The interval refreshes the compression base; reconstruction depth is
already one regardless of history length.

The delta matcher can locate shifted sequences inside the corresponding base
frame, but cannot reuse bytes from a different frame. Small insertions therefore
need not invalidate an entire frame; moving data across frame boundaries can
still defeat reuse.

Historical downloads stream and reconstruct only intersecting frames for ranges.
Queue work handles at most two frames per delivery. The current locator changes
only after staged data is verified and the fenced compare-and-swap succeeds.
Snapshot dependencies and in-flight work protect physical generations from GC.

## What the other systems do

### Git LFS

Git LFS puts a small pointer containing the whole-file SHA-256 and size into Git,
and keeps the full content separately. It avoids downloading the entire large
file history during ordinary checkout. Its standard object model does not define
cross-version deltas or similar-content deduplication; a backend may implement
physical storage optimizations independently.

GitHub explicitly bills a 500 MB object followed by a one-byte edit as 1 GB of
storage. This is evidence about GitHub's accounting, not its undisclosed physical
storage layout.

Sources: [LFS specification][lfs-spec], [GitHub LFS accounting][lfs-billing].

### Ordinary Git packfiles

Git's packer searches candidate objects for useful delta bases and permits delta
chains. The documented defaults are a candidate window of 10 and maximum depth 50. This can improve compression at the cost of encoding work and dependent
reconstruction. Better base selection could be explored independently of chains;
there is no reason to adopt deep chains merely to copy Git.

Source: [git-pack-objects][git-pack].

### Xet

Xet combines several mechanisms:

1. **Content-defined boundaries.** A 64-bit Gearhash selects chunks targeting
   64 KiB, with 8 KiB minimum and 128 KiB maximum, except a shorter final chunk.
   Content, not absolute file position, determines the boundaries.
2. **Separate cryptographic identity.** Xet uses BLAKE3-based chunk hashes for
   identity. The rolling boundary hash is not the integrity/deduplication hash.
3. **Packed immutable data.** New chunks are collected into objects called
   xorbs, with a maximum serialized size of 64 MiB. Individual chunks have an
   eight-byte header and independent raw/LZ4/ByteGrouping4LZ4 payloads.
4. **Flat reconstruction.** A file is an ordered sequence of chunk ranges from
   packs, not a dependency on an earlier file version. Shards carry reconstruction
   and deduplication metadata.
5. **Batched discovery.** In-session and cached metadata handle reuse locally.
   Global discovery samples eligible hashes and returns metadata for nearby
   chunks; it is not one remote existence query per chunk and is not exhaustive.
6. **Read locality over maximum reuse.** The documentation recommends keeping
   long contiguous runs together, even when this sacrifices some deduplication.
7. **Chunk-aware transfer.** Clients can avoid uploading existing chunks and
   reconstruct downloads from authorized packed ranges.

Sources: [chunking][xet-chunking], [hashing][xet-hashing],
[xorbs][xet-xorb], [deduplication][xet-dedup], [shards][xet-shard],
[upload protocol][xet-upload], [download protocol][xet-download].

The portable ideas are CDC, packed independently compressed chunks, indexed
lookup, and flat reconstruction. Adopting the Hugging Face client does not supply
Gitmatrix with a complete self-hosted storage and GC service.

## Measured evidence

### Real inputs

Read-only package queries against `https://gitmatrix.fward.dev` found three
published versions of `matrixorg/generic/gm`, but only two distinct contents.
The measured files were downloaded with `gm pkg download`, which verified their
whole-file SHA-256 checksums. No registry data was changed or executable installed.

| Input              | Published version                          |      Bytes | SHA-256                                                            |
| ------------------ | ------------------------------------------ | ---------: | ------------------------------------------------------------------ |
| Older Linux binary | `8926d9e44782008d1a6614a4f680fa2817710d09` | 10,859,056 | `60d3c0ad52d0b5ded3ea3a471af726f54f949d9cc606e78bf6316ed2e7983844` |
| Newer Linux binary | `f39fa1322a180b8f497eb1ea85427c3bf99fbe92` | 10,856,528 | `60e59f7ab74e125867baa01a155992013bbf7dae7a52db3916044b76f9c89fda` |

The other published version, `0c378bf4b432130777c06495cf79a0b6bc33d01c`, had the
same digest as the newer binary. Existing whole-file deduplication already
handles that case; it is not an additional benefit attributable to CDC.

### Method and verification

The temporary Node probe imported the actual `makeDelta`, `applyDelta`,
`compressFrame`, and `decompressFrame` functions from the repository.

The CDC implementation followed the documented Gearhash update and boundary
rules, using the upstream
[fixed Gearhash table at commit `adad44e7141cfd29d898cf6e0858f50b995db286`][gear-table].
Two unsigned 32-bit halves implemented the wrapping 64-bit hash. SHA-256 identified
chunk contents in the probe; this was a storage-strategy comparison, not a
wire-compatible Xet implementation.

Boundary conformance was checked against the upstream reference dataset's
`Electric_Vehicle_Population_Data_20250917.csv` and its `.chunks` file:

- Input size: 63,527,244 bytes.
- Input SHA-256: `f41255b252f776125f2b657136654e4d4d5d2ccf8ef4db0ec186bd1981b69734`.
- All **796 chunk lengths/boundaries matched** the published fixture.

Both strategies used our existing deflate/raw compression. This isolates chunk
reuse and compression-unit size; it does **not** measure Xet's native LZ4 or
ByteGrouping4LZ4 codecs. All available preceding chunks were indexed in memory,
so CDC had exhaustive reuse discovery within the sample rather than sampled
remote discovery.

The baseline stored the initial version as independently compressed 4 MiB full
frames. For the next version it measured both corresponding-frame deltas and full
frames, selecting a full snapshot if total delta payload exceeded half the full
payload, matching the existing policy for an eligible anchor.

For CDC, each new chunk was compressed and entered in a content-hash map. Each
version's ordered recipe was reconstructed from that map and verified byte for
byte. The probe also checked three partial ranges: the first byte, 150,007 bytes
starting at offset 32,761, and the final 70,001 bytes. Current-codec delta
reconstruction was verified byte for byte after compression/decompression.

### Additional payload for the second version

Exact byte counts; smaller is better. Synthetic cases start from the older real
binary, but are not additional observed releases.

| Case                                                                    | Current selected payload | CDC new payload | Current selection |
| ----------------------------------------------------------------------- | -----------------------: | --------------: | ----------------- |
| Actual published binary transition                                      |                1,809,424 |       5,030,253 | Delta             |
| Synthetic: XOR one byte with 1 every 65,536 bytes, starting at offset 0 |                    4,422 |       4,497,042 | Delta             |
| Synthetic: move the first 4 MiB to the end                              |                4,966,530 |          25,140 | Full snapshot     |
| Synthetic: prepend 131,072 bytes of `0x42`                              |                  108,214 |             145 | Delta             |
| Gzip each actual binary with Node `gzipSync` defaults                   |                4,959,238 |       4,958,105 | Full snapshot     |

For the actual transition, the CDC recipe had 162 chunks. Only four were reused:
131,763 bytes, or **1.21%** of the target. The other 158 chunks were new.

Including the initial compressed version:

| Strategy             | Initial payload | Second-version payload |      Total |
| -------------------- | --------------: | ---------------------: | ---------: |
| Current direct delta |       4,965,102 |              1,809,424 |  6,774,526 |
| Xet-style CDC        |       5,088,579 |              5,030,253 | 10,118,832 |

CDC used **49.4% more payload** for this real pair. The underlying distinction is
exact equality versus similarity: changing one byte makes a whole CDC chunk new,
whereas the delta encoder can preserve matching sequences inside it.

The prepend case also illustrates why incremental savings alone can mislead:
CDC added only 145 bytes, but its less efficiently compressed initial version
made the two-version total 5,088,724 bytes, versus 5,073,316 for current storage.

### Chunk-size sensitivity

The same real pair was compared at several target sizes. These are experimental
Xet-style variants, not alternative standard Xet parameters: minimum was target/8,
maximum was target*2, and the high-bit boundary mask was adjusted to the target.

| Target  | Target chunks in newer file | Reused target bytes | Compressed two-version total |
| ------- | --------------------------: | ------------------: | ---------------------------: |
| 4 KiB   |                       2,683 |               9.26% |                   11,144,406 |
| 16 KiB  |                         661 |               4.64% |                   10,412,647 |
| 64 KiB  |                         162 |               1.21% |                   10,118,832 |
| 256 KiB |                          41 |                  0% |                    9,993,913 |

Smaller chunks found more exact matches but made compression less effective and
increased descriptor counts. None beat the current 6,774,526-byte result.

### Limits of the evidence

- Only **one real transition** was available. Do not extrapolate its ratio to
  thousands of versions, other artifact families, or branching release histories.
- The numbers model cold historical representations, not the newest-two-versions
  raw policy or actual current R2 usage.
- Payload totals exclude manifests, indexes, pack headers, temporary staging,
  pinned snapshots, and partially dead packs.
- The pair comparison does not measure long-history anchor rotation, accumulated
  differences, retention, reverts, or cross-file reuse.
- This was a local codec/reconstruction probe, not an R2/D1/Worker integration or
  native Xet service benchmark. No production latency, CPU, memory, or cost claim
  follows from it.
- The gzip results concern Node-generated compressed copies of these inputs, not
  observed published archives. Other container/compression layouts may differ.
- The temporary probe and downloads were removed. This document preserves inputs,
  method, exact results, and sources; it is not a maintained benchmark harness.

## Integration constraints and a possible design

These are design requirements and proposals, not implemented behavior.

### Preserve the logical and HTTP contracts

CDC should be an internal cold-storage representation behind the existing blob
locator, if adopted. Keep whole-file SHA-256, size, URLs, checksums, ETags, HEAD,
Range, and attachment authorization unchanged. Retain the raw upload/hot path,
verified staging, durable checkpoints, and fenced source-locator compare-and-swap.

Background server compaction provides storage savings without client changes.
Avoiding uploads of known chunks requires a separate chunk-aware client protocol;
it is not a benefit of server compaction alone.

### Pack chunks and bound metadata work

At a 64 KiB target, 1 GiB has roughly 16,384 chunks versus 256 current 4 MiB frames.
One R2 object or synchronous existence request per chunk would multiply operations.
One D1 membership row per artifact/chunk would similarly multiply indexing,
publication, and deletion work. The current flat JSON manifest limit cannot simply
be retained while multiplying descriptor counts at the existing maximum file size.

A credible packed layout would need:

- Immutable packs with independently compressed chunks and physical offsets.
- Coalesced range reads, with an explicit fragmentation/read-amplification budget.
- Paged reconstruction recipes and deduplication index shards.
- Bounded lookup, staging, verification, and queue checkpoint work.
- Authoritative pack-generation references in addition to a lookup index; a stale
  index must not confer permission to adopt a pack already retiring.

Do not blindly copy Xet's 64 MiB packing target into an in-memory Worker encoder.
Workers have a 128 MB per-isolate memory limit, shared by concurrent invocations;
streaming construction or smaller bounded buffers are necessary design choices.
See [Workers memory limits][worker-memory].

### Treat shared-pack GC as a separate correctness problem

Deleting a publication must not delete chunks used by another retained version.
A pack containing one live chunk may retain many dead bytes. Reclaiming those
bytes requires writing surviving chunks elsewhere, safely switching references,
and retiring the old physical generation only after readers and in-flight work
are protected.

The current one-base dependency model is insufficient for arbitrary shared packs.
Both transactional reference accounting and checkpointed mark/sweep have costs;
neither is supplied by the chunker. Pack-level references reduce database
cardinality but do not by themselves reclaim partially live packs.

The public Xet API documents upload, reconstruction, and deduplication, not a
production deletion/GC contract. Upstream simulation code discusses relevant
hazards but is not evidence of deployed server retention guarantees. We would
have to design and verify our own publication/GC coordination.

Source: [Xet API][xet-api],
[upstream simulation deletion controls][xet-gc].

### Preserve access boundaries

Existing whole-file sharing is global, but bytes are reached only through an
authorized attachment. Finer-grained reuse must not create public hash-existence
or chunk-download APIs that bypass this boundary. An unrestricted signed URL for
a shared pack could expose neighboring private content; Worker-side artifact
reconstruction can keep packs private.

If client-side deduplication is later considered, repository/tenant-scoped
discovery is a more conservative starting point than global cross-owner lookup.
Xet's token, proof, HMAC-protected discovery, and signed-range mechanisms are
additional protocol work, not incidental details of CDC.

## When to resume

Resume when a larger retained history is available, rather than selecting a new
storage format from the synthetic relocation win alone.

Collect and compare:

1. Consecutive real versions from each important artifact family: executable
   builds, actual archives, large datasets/assets, and related platform variants.
   Include enough history to cross multiple current snapshot intervals.
2. Real deletion/retention patterns, reverts, and alternating release branches.
3. Current delta/full selection versus CDC, including all metadata, pinned bases,
   dead-pack space, and temporary compaction storage.
4. Cold full-download and small-Range latency, object-store request count,
   reconstruction fan-out, CPU, and peak Worker memory.
5. D1 rows/writes and queue deliveries per publication and per deletion.
6. Interrupted publication, stale dedup discovery, concurrent GC, and restoration
   after deleting the publication that originally supplied shared chunks.

The decision is whether a workload shows enough **net operational benefit** to
justify shared-chunk indexing and lifetime management. If CDC becomes worthwhile,
compare it as an alternative to deltas for suitable data, not an unconditional
replacement. Preserve the option that already compresses fine-grained edits well.

## Sources

Sources were consulted on 2026-10-02. Most upstream documentation URLs track a
moving current version; the Gearhash table commit and fixture digest above pin
the key benchmark inputs.

[lfs-spec]: https://github.com/git-lfs/git-lfs/blob/main/docs/spec.md
[lfs-billing]: https://docs.github.com/en/billing/concepts/product-billing/git-lfs
[git-pack]: https://git-scm.com/docs/git-pack-objects
[xet-chunking]: https://huggingface.co/docs/xet/chunking
[xet-hashing]: https://huggingface.co/docs/xet/hashing
[xet-xorb]: https://huggingface.co/docs/xet/xorb
[xet-dedup]: https://huggingface.co/docs/xet/deduplication
[xet-shard]: https://huggingface.co/docs/xet/shard
[xet-upload]: https://huggingface.co/docs/xet/upload-protocol
[xet-download]: https://huggingface.co/docs/xet/download-protocol
[xet-api]: https://huggingface.co/docs/xet/api
[xet-gc]: https://github.com/huggingface/xet-core/blob/main/xet_client/src/cas_client/simulation/deletion_controls.rs
[gear-table]: https://github.com/srijs/rust-gearhash/blob/adad44e7141cfd29d898cf6e0858f50b995db286/src/table.rs
[worker-memory]: https://developers.cloudflare.com/workers/platform/limits/#memory

Reference fixture: [xet-team/xet-spec-reference-files](https://huggingface.co/datasets/xet-team/xet-spec-reference-files).
