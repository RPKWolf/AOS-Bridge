# AOS Dashboard Architecture Review and Implementation Plan

**Review date:** 2026-08-10
**Review status:** COMPLETE — implementation gaps identified
**Scope:** documentation-only correction of PR #15. No production code, AOS Core, or Compass strategy was changed.

## Scope correction and review inputs

`AOS-Bridge /control` is a Bridge service UI. It is not the AOS Dashboard and
is explicitly excluded from this review.

The actual AOS repository is accessible at `/Users/radekkubes/AOS`. The
Dashboard implementation is under `dashboard/`, with its HTTP integration in
`main.ts`.

The approved Dashboard Design Authority is present in that repository:

- `docs/ARCHITECTURE_DECISIONS.md`, **ADR-011**, marks
  `docs/DASHBOARD_SPECIFICATION_v1.md` as approved and binding for Phase 4.
- **ADR-012** records the approved Dashboard v1 completion boundary.
- `docs/DASHBOARD_SPECIFICATION_v1.md` is therefore the comparison baseline;
  it is not replaced or supplemented by this document.

## Authority boundary

The authority defines Dashboard v1 / Phase 4B as a Czech, monitoring-first,
read-only UI over the server/API and repository layers. It explicitly excludes
advanced analytics, replay, snapshot viewer, alert channels (Telegram/Email),
trade or position editing, overrides, configuration workflows, and live trade
controls. It requires neither a position graph nor a separate Portfolio or
Trading Cockpit product.

Consequently, absence of a position chart, broad Analytics UI, notification
channels, or a separate Portfolio/Cockpit navigation item is **not a Phase 4B
non-conformance**. The current Trading Journal export is an additional AOS
capability, not evidence that such exports are required by Dashboard v1.

## Implementation examined

| Area | Actual AOS implementation examined |
| --- | --- |
| Phase 4B React foundation | `dashboard/app/dashboard-foundation-app.tsx`, layout, overview, monitoring, system components, view models and services |
| Read API | `dashboard/api/dashboard-{overview,positions,strategies,brokers,health,system-events}-route.ts` |
| Live HTTP composition | `main.ts` |
| Operational Paper Pilot dashboard | `dashboard/app/paper-pilot-dashboard-page.ts`, `dashboard/services/dashboard-paper-pilot-service.ts`, `/api/dashboard/paper-pilot` and SSE stream |
| Journal and exports | `dashboard/app/journal-dashboard-page.ts`, `dashboard/api/dashboard-journal-route.ts` |

## Authority comparison

| Authority area | Evidence in AOS | Result | Review conclusion |
| --- | --- | --- | --- |
| Read-only UI, API/service/repository flow | Dashboard routes instantiate Drizzle repositories and Dashboard services; view-model contracts separate UI from entities. | Meets in the API layer | The architecture is aligned; no client-side direct DB access was found. |
| Czech monitoring UI, layout, navigation, dark/light theme and Environment Banner | `DashboardLayout`, `TopBar`, `SidebarNav`, `ThemeProvider`; routes cover Přehled, Pozice, Strategie, Brokeři, Systém, Nastavení. Theme defaults to dark and persists in `localStorage`. | Meets in foundation | The required component boundary exists. |
| P/L, account, margin, exposure, open-position and active-strategy KPIs | `DashboardOverviewService`, `DashboardOverviewViewModel`, `OverviewDashboard`. | Meets in foundation/API | Today/week/month P/L and the required account/position/strategy aggregates are implemented. |
| Positions | `DashboardPositionsService`, `PositionTableRowViewModel`, `PositionsTable`. | Partial | Required broker/account, direction, lot, entry/current price, SL/TP, P/L and duration are present. Strategy metadata is optional as required. Pip/price-change and position-management state are not rendered. |
| Strategies | `DashboardStrategiesService`, `StrategiesTable`. | Meets | Name, state, mode, today’s signals and trades are rendered and the model supports multiple strategies. |
| Brokers, accounts and Paper/Live | `DashboardBrokersService`, `BrokersTable`, environment provider/banner. | Meets | Connection, account summary, balance/equity/free margin/exposure and open broker positions are represented per account. |
| AOS, worker, database, broker/session health; incidents/warnings | `DashboardHealthService`, `HealthWidget`, `SystemEventsList`; Paper Pilot also exposes detailed IBKR/session/recovery diagnostics. | Partial | Health aggregates configured broker, broker adapter and snapshot freshness, but its Phase 4B view model has no explicit AOS/worker/database component. Paper Pilot is more detailed but does not make the generic Phase 4B health widget complete. |
| Open orders | Paper Pilot runtime dashboard renders broker/open order information. | Available outside Phase 4B dashboard foundation | The approved v1 authority requires open positions, not an order table. The operational Paper Pilot view supplies this additional capability. |
| Portfolio, Trading Cockpit, Analytics and position graph | No approved Phase 4B requirement; no matching generic Dashboard v1 UI was found. | Out of scope | Do not record these as implementation defects without a newer approved authority. |
| Exports and notifications | Journal supports JSON/CSV/PDF export. Alert channels were not found. | Export available; notifications out of scope | Alert channels are explicitly excluded from Phase 4B. Journal export is independent of the Dashboard v1 acceptance criteria. |
| Mobile behaviour | `SidebarNav` has fixed desktop width and monitoring tables retain HTML-table rendering with horizontal overflow. No drawer, card list, or responsive breakpoint was found. | Does not meet | The Phase 4B mobile acceptance requirement is not implemented by the React foundation. |
| Production runtime integration | `main.ts` serves `renderPaperPilotDashboardPage()` for `/` and `/dashboard`; it does not render `DashboardFoundationApp`. The foundation itself constructs mock repositories/data. | **Does not meet** | The approved Phase 4B React dashboard and its real API data are not connected to the runtime UI. API endpoints exist, but they are not the data source of the rendered foundation. |

## P0 findings

1. **The Phase 4B Dashboard foundation is not production-composed.** The
   runtime routes `/` and `/dashboard` to the Paper Pilot HTML dashboard,
   while `DashboardFoundationApp` is not rendered by `main.ts`.
2. **The foundation is mock-backed.** `DashboardFoundationApp` creates mock
   repositories/services instead of consuming the existing dashboard API
   endpoints. If it were exposed, its monitoring data would not be production
   data.
3. **Phase 4B mobile behaviour is absent.** The authority requires a drawer,
   stacked KPIs, card lists and shortened event feed; the implementation uses
   a fixed sidebar and desktop tables with horizontal scrolling.

The first two findings prevent acceptance of the Phase 4B dashboard as an
operational production UI despite ADR-012’s completion record. They are
review findings against the current source tree, not a change to the ADR.

## Implementation plan (for the AOS repository, not AOS-Bridge)

| Priority | Work | Acceptance evidence |
| --- | --- | --- |
| P0 | Select the canonical Dashboard v1 route and compose the actual foundation there without replacing the Paper Pilot operational route unless an approved routing decision says so. | An HTTP/integration test proves the selected UI route renders the Phase 4B layout, banner, health and monitoring sections. |
| P0 | Replace foundation mock construction with read-only calls to the existing section API contracts (`overview`, `positions`, `strategies`, `brokers`, `health`, `system-events`) or an equivalent approved server composition. | A running UI shows repository/API-derived data; no dashboard production component imports mock data. |
| P0 | Implement the authority’s mobile drawer, stacked KPI/cards and condensed event feed. | Responsive tests or browser checks cover the mobile priorities: today P/L, account state, positions, brokers and recent events. |
| P1 | Extend the generic health contract only through an approved AOS design decision so it can report AOS, worker and database states alongside broker and sync status. | Health view model and service have explicit components with deterministic severity tests. |
| P1 | Close the two position-table omissions (pip/price-change and position-management state), preserving optional strategy enrichment. | Position view model/UI tests cover known values and unavailable metadata. |
| P2 | Consider Analytics, position chart, notifications, portfolio/cockpit navigation, or broader exports only after a new approved Dashboard authority defines their scope, source of truth and safety boundary. | New ADR/specification precedes implementation. |

## Verification boundary

This PR changes only this review document. No AOS source was altered and no
claim is made that the AOS runtime was changed or deployed. The AOS repository
contains `npm run test:dashboard`; it was not run because this documentation
change is in AOS-Bridge and the review performed no AOS code modification.
