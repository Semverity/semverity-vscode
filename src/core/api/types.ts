// Response shapes of the Semverity registry routes this extension calls, taken
// from the public OpenAPI document (GET https://api.semverity.dev/v1/openapi.yaml).
// Only the fields the extension reads are declared; every field the server may
// omit is optional. Unknown fields are ignored, so additive server changes never
// break parsing.

export type Grade = "A" | "B" | "C" | "D" | "F";

export type Resolution = "public" | "private_registry" | "not_found" | "collectors_failed";

/** The headline score: the package together with everything it pulls in. */
export interface Headline {
  score: number;
  grade: Grade;
  basis: "with_dependencies" | "own";
  context: "registry" | "repository";
  state: "complete" | "partial" | "pending" | "no_graph" | "not_collected";
  /** Percent (0..100) of the dependencies that are scored; absent for no_graph and not_collected. */
  coverage?: number;
  /** True whenever state is not complete: scoring more dependencies can only lower the score. */
  at_most: boolean;
  rollup_version?: number;
}

/** The package alone (the value of the legacy `overall`). */
export interface OwnScore {
  score: number;
  grade: Grade;
}

export interface SecurityScore {
  score: number;
  /** Empty when `scored` is false. */
  grade: Grade | "";
  scored: boolean;
  /** True when a malware or KEV finding forced the score to 0 and the grade to F. */
  gated?: boolean;
  /** Fraction 0..1 of the nominal component weight that had data. */
  coverage?: number;
}

export interface Gate {
  id: string;
  fired: boolean;
  hard: boolean;
  immutable: boolean;
  reason?: string;
  evidence?: string;
  evidence_at?: string;
  recommendation?: string;
}

export interface Dimension {
  id: string;
  name?: string;
  score: number;
  weight: number;
  coverage: number;
  capped?: boolean;
  note?: string;
}

export interface InheritedGate {
  gate: string;
  count: number;
  nearest_depth: number;
  path_class: "installed" | "optional";
  example_path: string[];
  caps_at: number | null;
}

export interface Contribution {
  purl: string;
  kind: "gate" | "weakest" | "breadth" | "others";
  gate?: string;
  points: number;
  own: number | null;
  depth: number;
  path_class: "installed" | "optional";
  path: string[];
}

export interface WithDependencies {
  context: "registry";
  state: "complete" | "partial" | "pending" | "no_graph" | "own_unscored";
  score: number | null;
  grade: Grade | null;
  own_grade?: Grade;
  coverage: number | null;
  nodes?: number;
  max_depth?: number;
  drop: number | null;
  inherited_gates?: InheritedGate[];
  top?: Contribution[];
  others?: { count: number; points: number };
  at_most: boolean;
  computed_at?: string;
}

/** Policy-free score card of one package version (GET .../versions/{v}, batch cards). */
export interface PackageCard {
  purl: string;
  ecosystem: string;
  name: string;
  version: string;
  resolution: Resolution;
  /** The own score (kept for the life of /v1). */
  overall: number;
  /** Evidence coverage of the own score, percent 0..100. */
  coverage: number;
  security_score?: SecurityScore;
  dimensions?: Dimension[];
  gates?: Gate[];
  flags?: string[];
  notes?: string[];
  license?: string;
  scoring_version?: number;
  evaluated_at?: string;
  detail?: "full" | "compact";
  source?: "index";
  advisory_ids?: string[];
  with_dependencies?: WithDependencies;
  /** Omitted while the own score is unknown. */
  headline?: Headline;
  own?: OwnScore;
}

export interface PackageVersionEntry {
  version: string;
  purl: string;
  overall?: number;
  security_score?: SecurityScore;
  resolution?: string;
  fired_gates?: string[];
  prerelease?: boolean;
  yanked?: boolean;
  deprecated?: boolean;
  published_at?: string;
  evaluated_at?: string;
  headline?: Headline;
  own?: OwnScore;
}

/** GET /v1/packages/{ecosystem}/{name}: known versions with the healthy pick. */
export interface PackageList {
  ecosystem: string;
  name: string;
  purl: string;
  versions: PackageVersionEntry[];
  /** The healthy-version pick per `strategy`. */
  healthy?: string;
  strategy?: string;
  latest?: string;
  description?: string;
  source?: "index";
  headline?: Headline;
  own?: OwnScore;
}

/** 202 body of a single lookup that started a collection (signed in only). */
export interface Pending {
  purl: string;
  status: "collecting";
  status_url: string;
  retry_after_seconds: number;
}

export interface BatchRequest {
  purls: string[];
}

export interface BatchResponse {
  cards: PackageCard[];
  /** Signed in only: purls being collected. */
  pending?: Pending[];
  /** Entries that are not valid purls, in request order. */
  invalid?: string[];
  /** Signed out only: valid purls the public index does not hold. */
  not_indexed?: string[];
}

export type ErrorCode =
  | "bad_request"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "not_indexed"
  | "payload_too_large"
  | "rate_limited"
  | "unavailable"
  | "timeout"
  | "internal"
  | (string & {});

export interface ErrorResponse {
  code: ErrorCode;
  message: string;
  details?: string[];
  request_id?: string;
}
