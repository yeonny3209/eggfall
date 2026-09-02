/**
 * EGGFALL — 프로젝트 최상단 타입 정의
 *
 * 기획서 §13.2: "타입을 먼저 고정. 이게 AI의 기억이다."
 * 이 파일이 곧 계약이다. 여기 없는 개념은 아직 존재하지 않는 것으로 취급한다.
 */

/* ==========================================================================
   속성 · 상태이상 · 반응 (기획서 §3)
   ========================================================================== */

/** 기본 속성 6종 (§3.2) */
export type Element = 'ember' | 'rime' | 'gale' | 'blight' | 'terra' | 'umbra';

export const ELEMENTS: readonly Element[] = ['ember', 'rime', 'gale', 'blight', 'terra', 'umbra'];

/**
 * 상태이상 6종 (§3.2)
 * 설계 핵심: 대부분이 "피해"가 아니라 비행 능력에 대한 간섭이다.
 * 이 게임의 진짜 죽음은 체력 0이 아니라 추락이기 때문이다.
 */
export type StatusId = 'burn' | 'chill' | 'shock' | 'corrode' | 'weight' | 'devour';

/** 속성 → 그 속성이 부여하는 상태이상. 1:1 대응이다. */
export const STATUS_OF: Record<Element, StatusId> = {
  ember: 'burn',
  rime: 'chill',
  gale: 'shock',
  blight: 'corrode',
  terra: 'weight',
  umbra: 'devour',
};

/** 대상에 걸린 상태이상 1건 */
export type StatusStack = {
  id: StatusId;
  stacks: number;
  /** 만료 시각 (ms, 서버 기준 단조 시계) */
  expiresAt: number;
  /** 심연 각인이 걸리면 해제 불가 (§3.3) */
  locked: boolean;
};

/** 반응 6종 (§3.3) */
export type ReactionId =
  | 'steamBurst' // 발화 + 결빙 → 증기 폭발
  | 'plagueFlame' // 발화 + 부식 → 역병 불꽃
  | 'downfall' // 감전 + 중압 → 추락
  | 'nervePalsy' // 감전 + 부식 → 신경 마비
  | 'crystalCollapse' // 결빙 + 중압 → 결정 붕괴
  | 'abyssalBrand'; // 잠식 + 임의 → 심연 각인

/** 친화도 유형 (§3.5) — 명확한 트레이드오프가 육성 방향을 "선택"으로 만든다 */
export type AffinityKind = 'pure' | 'dual' | 'mongrel';

/* ==========================================================================
   스킬 (기획서 §4)
   ========================================================================== */

/** 코어 12종 — 무엇을 하는가 (§4.2) */
export type CoreId =
  | 'breath'
  | 'bolt'
  | 'field'
  | 'charge'
  | 'smash'
  | 'summon'
  | 'aura'
  | 'bind'
  | 'warp'
  | 'reflect'
  | 'drain'
  | 'burst';

/** 형상 8종 — 어떻게 전달되는가 (§4.2) */
export type ShapeId =
  | 'cone'
  | 'pierce'
  | 'sphere'
  | 'trail'
  | 'selfCentered'
  | 'groundTarget'
  | 'homing'
  | 'delayedTrap';

/** 변조 20종 — 부가 특성 (§4.2). 수치가 아니라 행동을 바꾼다 (§12 리스크 대응) */
export type ModifierId =
  | 'penetrate'
  | 'split'
  | 'chain'
  | 'lifesteal'
  | 'slow'
  | 'stackUp'
  | 'frenzy'
  | 'coolant'
  | 'expand'
  | 'compress'
  | 'delay'
  | 'instant'
  | 'statusUp'
  | 'noRecoil'
  | 'updraft'
  | 'cloak'
  | 'doubleCast'
  | 'reignite'
  | 'rampage'
  | 'precision';

/** 유전 특성 — 알을 흡수하면 발현 풀에 쌓인다 (§4.4) */
export type Trait = {
  element: Element;
  /** 이 특성이 밀어주는 코어·변조 */
  core?: CoreId;
  modifier?: ModifierId;
  /** 가중 랜덤에서의 무게 */
  weight: number;
};

/** 절차적으로 생성된 스킬 1개 (§10) */
export type GeneratedSkill = {
  core: CoreId;
  shape: ShapeId;
  modifiers: ModifierId[]; // 0~3
  element: Element;
  /** 파워 예산으로 산출 (§4.4) — 조합이 10만 개여도 총합은 항상 같다 */
  power: number;
  generatedName: string;
  /** 신성 스킬은 true — 재발현·복제·거래 불가 (§5.1) */
  locked: boolean;
};

/* ==========================================================================
   드래곤 (기획서 §6, §10)
   ========================================================================== */

/** 성장 단계 1~6 (§6.1) */
export type Stage = 1 | 2 | 3 | 4 | 5 | 6;

export type DragonStats = {
  vigor: number; // 체력
  ferocity: number; // 화력
  agility: number; // 민첩
  stamina: number; // 지구력
  sense: number; // 감각
  dread: number; // 위압
};

export type Dragon = {
  id: string;
  ownerId: string;
  stage: Stage;
  /** 성장은 오직 흡수한 알의 유전 질량 총합으로만 결정된다 (§6.1) */
  geneMass: number;
  /** 외형·스킬 발현·상태이상 강도를 동시에 결정 (§3.5) */
  elementAffinity: Record<Element, number>;
  /** 흡수 이력 누적 (§4.4) */
  expressionPool: Trait[];
  skills: GeneratedSkill[]; // 최대 4
  divineCore: DivineId | null;
  stats: DragonStats;
  nestId: string | null;
};

/* ==========================================================================
   알 (기획서 §7)
   ========================================================================== */

export type Rarity = 'common' | 'uncommon' | 'rare' | 'epic' | 'divine';

export type DragonEgg = {
  id: string;
  rarity: Rarity;
  element: Element;
  geneMass: number;
  /** 스킬 발현 풀에 투입 */
  traits: Trait[];
  /** 미부화 소멸 시각 */
  decayAt: number;
  /** 신성 알만 보유 (1~12) */
  divineId?: DivineId;
};

/* ==========================================================================
   신성 (기획서 §5)
   ========================================================================== */

/** 12신성. 숫자가 아니라 이름으로 다룬다 — divines.json 의 키와 일치해야 한다. */
export type DivineId =
  | 'solaris'
  | 'niflheim'
  | 'keraunos'
  | 'verd'
  | 'morgul'
  | 'atlas'
  | 'abyss'
  | 'kronos'
  | 'baral'
  | 'echo'
  | 'crimson'
  | 'thanatos';

export const DIVINE_IDS: readonly DivineId[] = [
  'solaris',
  'niflheim',
  'keraunos',
  'verd',
  'morgul',
  'atlas',
  'abyss',
  'kronos',
  'baral',
  'echo',
  'crimson',
  'thanatos',
];

export type DivineStatus = 'dormant' | 'awakening' | 'claimed' | 'loose';

/**
 * 각성 조건 (§5.2)
 * 전부 counters 에 대한 임계값 체크 하나로 처리한다.
 * 조건을 나중에 추가·변경하기 쉬워진다.
 */
export type AwakenCondition = {
  counter: string;
  threshold: number;
  /** UI 표시용 한국어 설명 */
  label: string;
};

/** 신성용 정의 — 코드가 아니라 데이터다 (§13.5) */
export type DivineDef = {
  id: DivineId;
  name: string;
  epithet: string;
  element: Element | 'life' | 'time' | 'gravity' | 'illusion' | 'blood' | 'end';
  awaken: AwakenCondition;
  /** 권능 1개 + 고유 스킬 2개 */
  power: { name: string; desc: string };
  skills: { name: string; desc: string }[];
  /** 대가가 없으면 게임이 끝난다 (§5.3) */
  cost: string;
};

/* ==========================================================================
   시즌 상태 — 샤드당 1개 (기획서 §10)
   ========================================================================== */

export type SeasonState = {
  seasonId: string;
  divineEggs: Record<
    DivineId,
    {
      status: DivineStatus;
      holderId: string | null;
      /** 서버 역사 — 각 핵마다 역대 보유자가 기록된다 (§5.4) */
      history: { playerId: string; claimedAt: number }[];
    }
  >;
  /** 각성 조건 추적용 누적 카운터 (§5.2) */
  counters: Record<string, number>;
};

/* ==========================================================================
   비행 (Phase 0)
   ========================================================================== */

/**
 * 조종 입력 1프레임분. 넷코드에서 그대로 직렬화할 수 있도록 순수 데이터로 둔다.
 *
 * "스펙테이터 캠" 모델 — 마우스가 보는 방향이 곧 비행 방향이다.
 * 요/피치는 여기 없다. InputSource 가 마우스 이동을 직접 누적해
 * FlightState.yaw/pitch 에 반영하기 때문이다 (조작을 최대한 단순하게 두기 위함).
 */
export type FlightInput = {
  /** -1 ~ 1, 보는 방향 기준 전진/후진 (W/S) */
  forward: number;
  /** -1 ~ 1, 보는 방향 기준 좌우 이동 (A/D) */
  strafe: number;
  /** Space 누르는 동안 상승 */
  ascend: boolean;
  /** Shift 누르는 동안 하강 */
  descend: boolean;
};

/**
 * 비행 상태. 렌더링과 분리해 순수하게 유지한다 (§13.3 정신).
 * 이 구조체만 있으면 서버에서도 동일하게 시뮬레이션할 수 있다.
 */
export type FlightState = {
  /** 위치 (m) */
  x: number;
  y: number;
  z: number;
  /** 속도 (m/s) — 즉시 정지/출발이 아니라 부드럽게 가감속하기 위해 둔다 */
  vx: number;
  vy: number;
  vz: number;
  /** 보는 방향이자 비행 방향 (rad) */
  yaw: number;
  pitch: number;
  /** 착륙 상태 — 지면에 닿아 있으면 true */
  grounded: boolean;
};

/** 고도 3층 구조 (§9) — 지금은 시각적 구분일 뿐 스태미나 등 수치 효과는 없다 */
export type Layer = 'low' | 'mid' | 'high';
