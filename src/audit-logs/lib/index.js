import path from 'path'

import { readCompressedJsonFileFallback } from '#src/frame/lib/read-json-file.js'
import { getOpenApiVersion } from '#src/versions/lib/all-versions.js'

export const AUDIT_LOG_DATA_DIR = 'src/audit-logs/data'

// cache of audit log data
const auditLogEventsCache = new Map()

// get audit log event data for the requested page and version
//
// if categorized is false, returns an array of event objects that look like this:
//
// [
//   {
//     action: 'account.billing_date_change',
//     description: 'event description',
//     docs_reference_links: 'event reference links'
//   },
// ]
//
// if categorized is true, group events by category; the category is the first
// part of the event action (e.g. category is `repo` for the `repo.create` event)
// so we extract the categories and then group events under those categories
// and return an object that looks like this:
//
// {
//   git: [ [Object], [Object] ],
//   repo: [ [Object] ],
//   user: [ [Object], [Object] ]
// }
export function getAuditLogEvents(page, version, categorized = false) {
  const openApiVersion = getOpenApiVersion(version)
  const auditLogFileName = path.join(AUDIT_LOG_DATA_DIR, openApiVersion, `${page}.json`)

  // If the data isn't cached for an entire version or a particular page, read
  // the data from the JSON file the first time around
  if (!auditLogEventsCache.has(openApiVersion)) {
    auditLogEventsCache.set(openApiVersion, new Map())
    auditLogEventsCache.get(openApiVersion).set(page, new Map())
    auditLogEventsCache
      .get(openApiVersion)
      .set(page, readCompressedJsonFileFallback(auditLogFileName))
  } else if (!auditLogEventsCache.get(openApiVersion).has(page)) {
    auditLogEventsCache.get(openApiVersion).set(page, new Map())
    auditLogEventsCache
      .get(openApiVersion)
      .set(page, readCompressedJsonFileFallback(auditLogFileName))
  }

  const auditLogEvents = auditLogEventsCache.get(openApiVersion).get(page)
  // If an event doesn't yet have a description (value will be empty string or
  // "N/A"), then we don't show the event.
  const filteredAuditLogEvents = auditLogEvents.filter(
    (event) => event.description !== 'N/A' && event.description !== '',
  )

  if (!categorized) {
    return filteredAuditLogEvents
  }

  const categorizedEvents = {}
  filteredAuditLogEvents.forEach((event) => {
    const [category] = event.action.split('.')
    if (!Object.hasOwn(categorizedEvents, category)) {
      categorizedEvents[category] = []
    }

    categorizedEvents[category].push({
      action: event.action,
      description: event.description,
    })
  })

  return categorizedEvents
}

// Filters audit log events based on allowlist values.
//
// * eventsToCheck: events to consider
// * currentEvents: events already collected
// * allowListvalues: allowlist values to filter by
// * pipelineConfig: audit log pipeline config data
// * filterConfig: filter config options
export function filterByAllowlistValues(
  eventsToCheck,
  currentEvents,
  allowListValues,
  pipelineConfig,
  filterConfig = {
    filterFn: filterOr,
  },
) {
  if (!Array.isArray(allowListValues)) allowListValues = [allowListValues]
  if (!currentEvents) currentEvents = []

  const seen = new Set(currentEvents.map((event) => event.action))
  const minimalEvents = []

  for (const event of eventsToCheck) {
    if (event._allowlists === null) continue

    if (filterConfig.filterFn(event._allowlists, allowListValues)) {
      if (seen.has(event.action)) continue
      seen.add(event.action)

      const minimal = {
        action: event.action,
        description: event.description,
        docs_reference_links: event.docs_reference_links,
      }

      if (
        event._allowlists.includes('org_api_only') ||
        event._allowlists.includes('business_api_only')
      ) {
        minimal.description += ` ${pipelineConfig.apiOnlyEventsAdditionalDescription}`
      }

      minimalEvents.push(minimal)
    }
  }
  return [...minimalEvents, ...currentEvents]
}

// Filters audit log events based on allowlist values and processes an
// event's supported GHES versions.
//
// * eventsToCheck: events to consider
// * currentEvents: events already collected
// * allowListvalue: allowlist value to filter by
// * pipelineConfig: audit log pipeline config data
// * auditLogPage: the audit log page the event belongs to
//
// Mutates `currentGhesEvents` and updates it with any new filtered for audit
// log events, the object maps GHES versions to page events for that version e.g.:
//
// {
//   ghes-3.10': {
//     organization: [...],
//     enterprise: [...],
//     user: [...],
//   },
//   ghes-3.11': {
//     organization: [...],
//     enterprise: [...],
//     user: [...],
//   },
// }
export function filterAndUpdateGhesDataByAllowlistValues(
  eventsToCheck,
  currentGhesEvents,
  allowListValue,
  pipelineConfig,
  auditLogPage,
) {
  if (!currentGhesEvents) currentGhesEvents = {}

  const seenByGhesVersion = new Map()
  for (const [ghesVersion, events] of Object.entries(currentGhesEvents)) {
    if (!events[auditLogPage]) continue
    const pageEvents = new Set(events[auditLogPage].map((e) => e.action))
    seenByGhesVersion.set(ghesVersion, pageEvents)
  }

  for (const event of eventsToCheck) {
    for (const ghesVersion of Object.keys(event.ghes)) {
      const ghesVersionAllowlists = event.ghes[ghesVersion]._allowlists
      const fullGhesVersion = `ghes-${ghesVersion}`

      if (ghesVersionAllowlists === null) continue
      if (seenByGhesVersion.get(fullGhesVersion)?.has(event.action)) continue

      const minimal = {
        action: event.action,
        description: event.description,
        docs_reference_links: event.docs_reference_links,
      }

      if (ghesVersionAllowlists.includes(allowListValue)) {
        if (
          ghesVersionAllowlists.includes('org_api_only') ||
          ghesVersionAllowlists.includes('business_api_only')
        ) {
          minimal.description += ` ${pipelineConfig.apiOnlyEventsAdditionalDescription}`
        }

        // we need to initialize as we go to build up the `minimalEvents`
        // object that we'll return which will contain the GHES events for
        // each versions + page type combos e.g. when processing GHES events
        // for the organization events page we'll end up with something like
        // this:
        //
        // {
        //   'ghes-3.10': { organization: [Array] },
        //   'ghes-3.11': { organization: [Array] },
        //   'ghes-3.8': { organization: [Array] },
        //   'ghes-3.9': { organization: [Array] }
        // }
        if (!currentGhesEvents[fullGhesVersion]) {
          currentGhesEvents[fullGhesVersion] = {}
          currentGhesEvents[fullGhesVersion][auditLogPage] = []
        } else {
          if (!currentGhesEvents[fullGhesVersion][auditLogPage]) {
            currentGhesEvents[fullGhesVersion][auditLogPage] = []
          }
        }

        currentGhesEvents[fullGhesVersion][auditLogPage].push(minimal)
      }
    }
  }
}

function filterOr(array, conditions) {
  return conditions.some((condition) => array.includes(condition))
}
