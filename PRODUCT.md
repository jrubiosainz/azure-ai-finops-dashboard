# Product

## Purpose

A local, read-only reference dashboard for engineers and FinOps teams reviewing an
Azure AI estate. It joins cost, usage, inventory and optional telemetry without
presenting inferred allocations as individual invoices.

## Distribution

The repository contains no customer subscription or resource configuration.
`npm run demo` creates entirely synthetic data in memory. `npm start` reads the
subscription explicitly configured in a local `.env`, using Azure CLI credentials.
The screenshot in `docs/images/` is generated exclusively from the synthetic mode.

## Sources and trust

- Cost Management supplies `ActualCost`, grouped by resources, services and meters.
- Azure Monitor supplies token and request metrics where accounts publish them.
- ARM and the Foundry data plane supply accounts, deployments, projects and agents.
- Application Insights / Log Analytics supply optional GenAI records, not necessarily
  one record per model request.
- API Management supplies optional business membership and gateway reports.

Billed means recorded cost, metered means observed usage, derived means a calculation
or token-based attribution, and modelled means an explicit allocation.
Every example amount is fictional, not a public model price.

## Boundaries

Cost Management does not expose a model-deployment dimension. The engine interprets
meter names and allocates an account/model's cost by deployment token share.
Unknown meters, retired deployments, adjustments and incomplete metrics can prevent
reconciliation. The dashboard reports attribution gaps; it does not fabricate matches.

Agent allocation divides the deployment among uniquely identified registered agents.
Project allocation uses agent counts, or a project split when there are no agents.
Neither proves actual individual usage. Telemetry is separate evidence and does not
automatically correct these allocations.

Business cases regroup their member deployments, not the whole subscription bill.
Each deployment must belong to a single case in the supported registry format.
Gateway requests and model metrics may represent different traffic.

## Interaction

The cascade selects related infrastructure or deployments. The daily tape, call
evidence and lower use-case register remain global and are labelled accordingly.
The telemetry cascade operates on retained records; cost quotations remain global.
Selecting a meter does not invent per-meter token or request measurements.

## Non-goals

No forecasting, budget enforcement, automated provisioning, model traffic generation,
per-user chargeback, multi-user web hosting or production authentication.
There are no telemetry coverage or cost claims tied to a particular real estate.

For installation, permissions and known limits, see `README.md` and
`docs/azure-setup.md`.
