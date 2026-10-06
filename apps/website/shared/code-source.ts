export interface CodeSource {
  sourceId: string;
  repoId: string;
  kind: "canonical" | "timeline-work" | "canonical-historical";
  timelineId: string | null;
  ref: string;
}

export interface SourceSnapshot extends CodeSource {
  commit: string;
  tree: string;
}

export interface SourceDependency {
  source: SourceSnapshot;
  base: SourceSnapshot;
}
