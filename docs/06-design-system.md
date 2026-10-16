# DataSentinel Bauhaus Design System

## 1. Design intent

DataSentinel is an operational tool. A user should see what is healthy, what needs attention, why it failed, and what they can safely do next. Use Bauhaus ideas—geometry, clear hierarchy, grids, strong type, and purposeful color—to organize information rather than decorate it.

## 2. Visual principles

1. **Function first:** Every shape, color, and label helps users scan or act.
2. **Geometric structure:** Use aligned rectangles, circles, rules, and occasional triangles as purposeful indicators.
3. **Strong hierarchy:** Large page title, concise state summary, then evidence and actions.
4. **Asymmetry with alignment:** Use varied column widths inside a consistent grid; avoid random card layouts.
5. **Color with meaning:** Reserve primary colors for status, severity, and selected emphasis. Always pair color with text/icon.
6. **Direct language:** Prefer “Last checked 8 minutes ago” and “Expected at least 7,000 rows” over vague labels.
7. **Density with breathing room:** Operational tables can be compact, but content must remain readable and touch targets usable.

## 3. Starter visual tokens

Treat these as initial design tokens; verify contrast in the implemented components before release.

| Token           | Suggested value | Use                                                              |
| --------------- | --------------- | ---------------------------------------------------------------- |
| `ink`           | `#171717`       | Primary text, borders, icons                                     |
| `paper`         | `#F4F1E8`       | Main page background                                             |
| `surface`       | `#FFFFFF`       | Cards, forms, tables                                             |
| `signal-red`    | `#C83225`       | Critical failure accents and severity marks; pair with text/icon |
| `signal-blue`   | `#24528A`       | Navigation/selected state and informational emphasis             |
| `signal-yellow` | `#F0C64A`       | Warning/highlight surface; use dark text on it                   |
| `line`          | `#B8B4AA`       | Dividers and table rules                                         |
| `success`       | `#236B4A`       | Healthy/pass status with label/icon                              |

Use color tokens as small, consistent areas rather than making every panel brightly colored. Confirm text and control contrast against WCAG AA targets. Do not encode status by color alone.

## 4. Type and spacing

- Use a clean sans-serif family such as Inter or a system sans fallback. Keep a monospace face for IDs, timestamps where helpful, code, and exact values.
- Establish a small type scale: display/page title, section heading, body, compact table text, helper text. Avoid using many weights/sizes in one screen.
- Use an 8px spacing base, with 4px for fine adjustments. Use consistent spacing tokens, not one-off values.
- Prefer 1px functional borders and clear grouping to excessive shadows or pill-shaped containers.
- Use sentence case for navigation and controls.

## 5. Layout and responsive behavior

- Desktop: persistent left navigation, top workspace/context bar, content grid, and optional right evidence/inspector panel.
- Use a 12-column content grid at wide sizes. Keep dashboard overview, incident list, and detail pages aligned to the same left edge.
- Tablet: collapse secondary navigation and stack supporting panels; keep primary actions visible.
- Mobile: use a compact top bar, single-column cards, horizontal table scrolling only when necessary, and sticky primary actions on long forms where useful.
- Never require hover to reveal critical information or actions.
- Respect reduced-motion preference. Use small, brief transitions only to clarify state change.

## 6. Navigation and screens

### Global navigation

- Overview
- Incidents
- Data sources
- Datasets
- Pipeline runs
- Integrations
- Workspace settings

Show current workspace clearly. Provide a visible user menu and role context. Admin-only destinations may be hidden from unauthorized roles, but API checks still enforce access.

### Dashboard

- Header with workspace, time window, and last refresh.
- Large health summary with explicit status and count of failed/warning checks.
- Active incident list prioritized by severity and age.
- Recent pipeline/check activity timeline.
- Dataset freshness panel with last success and next scheduled check.
- Empty state should explain the first setup action: register a source or upload a sample CSV.

### Data source list and setup

- Source rows show type icon, name, status text, last check, owner, and schedule.
- Add-source flow uses short steps: choose type, enter connection details/upload, validate, choose dataset, set schedule.
- Connection errors show safe actionable hints. Never echo credentials or raw provider error content.
- Provide clear paused/archived state and credential-rotation entry point.

### Dataset detail

- Summary strip: health, row count, freshness, last profile, source.
- Tabs or segmented navigation: Overview, Rules, Profile, Schema history, Check history.
- Profile table includes field, type, null count/percent, uniqueness or duplicate metric when enabled.
- Schema drift uses side-by-side old/new fields and text labels such as Added, Removed, Type changed.
- Historical charts label the comparison window and missing-data gaps.

### Rule builder

- Start with a human-readable rule type selector and short explanation.
- Configure only fields relevant to the selected rule.
- Preview the rule in plain language and show sample expected/actual result shape.
- Explain insufficient history and cost/scan impact before enabling a heavy check.
- Display validation errors next to the field and preserve user input after error.

### Incidents

- List filters: status, severity, dataset, owner, time range.
- Rows show severity text/icon, title, dataset, opened time, owner, and status.
- Detail order: summary and state/actions; failed rule and expected-versus-actual; evidence and related runs; AI investigation; comments/status history; resolution.
- Clearly mark AI-generated hypotheses and link each cited evidence item.
- Resolution form requires a concise note; reopening requires a reason.

### Integrations and approvals

- Show integration status, permissions/scopes, last delivery, and credential rotation state.
- Show a preview before test notification or action.
- Approval view names the target and exact effect. Keep Approve and Reject distinct and require confirmation for consequential actions.
- Surface failed deliveries/executions with redacted troubleshooting details.

## 7. Reusable component vocabulary

- `StatusMark`: geometric symbol plus explicit status label.
- `SeverityBadge`: icon/shape and label; no color-only badge.
- `MetricBlock`: value, label, change/comparison window, and optional sparkline.
- `EvidenceRow`: evidence type, time, source link, safe summary.
- `RuleSummary`: plain-language rule sentence and enabled/severity state.
- `Timeline`: check/pipeline/incident events with clear actor and timestamp.
- `EmptyState`: what is missing, why it matters, and one next action.
- `ConfirmActionDialog`: target, effect, permission, approval state, and cancellation path.
- `DataTable`: consistent filters, sorting, pagination, loading/error/empty states.

## 8. Interaction and accessibility

- All controls support keyboard navigation with a visible focus indicator.
- Use semantic headings, labels, tables, dialogs, and live regions for async status updates.
- Associate validation errors and helper text with their form fields.
- Provide text alternatives for charts and non-text geometry.
- Use accessible contrast, do not rely on color alone, and allow browser zoom/reflow.
- Give async actions a clear queued/running/succeeded/failed state and a route to the resulting resource.
- Prevent destructive actions from being triggered by accidental double clicks; use idempotency and clear confirmation.
- Keep error text concise and actionable without exposing internals.

## 9. Bauhaus review checklist

- [ ] Grid alignment and spacing are consistent.
- [ ] Each color and geometric shape has a functional meaning.
- [ ] Primary action is easy to find; secondary actions remain visually secondary.
- [ ] Health state and severity are understandable without color.
- [ ] Data tables remain legible at narrow widths and with long names.
- [ ] Loading, empty, permission-denied, offline, and error states are designed.
- [ ] Forms retain input and explain validation errors.
- [ ] Keyboard focus and contrast are visible and usable.
- [ ] Charts show units, dates, baselines, and gaps.
- [ ] No fake/placeholder metrics appear as live production data.
