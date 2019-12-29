import _ from 'lodash'
import { Db } from 'mongodb'
import { ratioToPercentage, appendCompletionToYearlyResults } from './common'
import { getEntity } from '../helpers'
import { SurveyConfig } from '../types'
import { Filters, generateFiltersQuery } from '../filters'

interface ExperienceBucket {
    id: string
    count: number
}

const computeAwareness = (buckets: ExperienceBucket[], total: number) => {
    const neverHeard = buckets.find(bucket => bucket.id === 'never_heard')
    if (neverHeard === undefined) {
        return 0
    }

    return ratioToPercentage((total - neverHeard.count) / total)
}

const computeInterest = (buckets: ExperienceBucket[]) => {
    const interested = buckets.find(bucket => bucket.id === 'interested')
    const notInterested = buckets.find(bucket => bucket.id === 'not_interested')
    if (interested === undefined || notInterested === undefined) {
        return 0
    }

    return ratioToPercentage(interested.count / (interested.count + notInterested.count))
}

const computeSatisfaction = (buckets: ExperienceBucket[]) => {
    const wouldUse = buckets.find(bucket => bucket.id === 'would_use')
    const wouldNotUse = buckets.find(bucket => bucket.id === 'would_not_use')
    if (wouldUse === undefined || wouldNotUse === undefined) {
        return 0
    }

    return ratioToPercentage(wouldUse.count / (wouldUse.count + wouldNotUse.count))
}

export const computeExperienceOverYears = async (
    db: Db,
    survey: SurveyConfig,
    tool: string,
    filters?: Filters
) => {
    const collection = db.collection('normalized_responses')

    const path = `tools.${tool}.experience`

    const match = {
        survey: survey.survey,
        [path]: { $nin: [null, ''] },
        ...generateFiltersQuery(filters)
    }

    const results: Array<{
        year: number
        experience: string
        total: number
    }> = await collection
        .aggregate([
            {
                $match: match
            },
            {
                $group: {
                    _id: {
                        experience: `$${path}`,
                        year: '$year'
                    },
                    total: { $sum: 1 }
                }
            },
            {
                $project: {
                    _id: 0,
                    experience: '$_id.experience',
                    year: '$_id.year',
                    total: 1
                }
            }
        ])
        .toArray()

    // group by years and add counts
    const experienceByYear = _.orderBy(
        results.reduce<
            Array<{
                year: number
                total: number
                awarenessInterestSatisfaction: {
                    awareness: number
                    interest: number
                    satisfaction: number
                }
                buckets: Array<{
                    id: string
                    count: number
                    percentage: number
                }>
            }>
        >((acc, result) => {
            let yearBucket = acc.find(b => b.year === result.year)
            if (yearBucket === undefined) {
                yearBucket = {
                    year: result.year,
                    total: 0,
                    awarenessInterestSatisfaction: {
                        awareness: 0,
                        interest: 0,
                        satisfaction: 0
                    },
                    buckets: []
                }
                acc.push(yearBucket)
            }

            yearBucket.buckets.push({
                id: result.experience,
                count: result.total,
                percentage: 0
            })

            return acc
        }, []),
        'year'
    )

    // compute percentages
    experienceByYear.forEach(bucket => {
        bucket.total = _.sumBy(bucket.buckets, 'count')
        bucket.buckets.forEach(subBucket => {
            subBucket.percentage = ratioToPercentage(subBucket.count / bucket.total)
        })
    })

    // compute awareness/interest/satisfaction
    experienceByYear.forEach(bucket => {
        bucket.awarenessInterestSatisfaction = {
            awareness: computeAwareness(bucket.buckets, bucket.total),
            interest: computeInterest(bucket.buckets),
            satisfaction: computeSatisfaction(bucket.buckets)
        }
    })

    return appendCompletionToYearlyResults(db, survey, experienceByYear)
}
/*
const computeToolExperience = async (db: Db, options, tool, year, survey) => {
    const collection = db.collection('normalized_responses')

    const path = `tools.${tool}.experience`

    const results = await collection
        .aggregate([
            {
                $match: {
                    survey: survey.survey,
                    year,
                    // exclude null and empty values
                    [path]: { $nin: [null, ''] }
                }
            },
            {
                $group: {
                    _id: {
                        experience: `$${path}`
                    },
                    count: { $sum: 1 }
                }
            },
            // reshape documents
            {
                $project: {
                    _id: 0,
                    id: '$_id.experience',
                    count: 1
                }
            }
        ])
        .toArray()

    // compute percentages
    const total = _.sumBy(results, 'count')
    results.forEach(bucket => {
        bucket.percentage = ratioToPercentage(bucket.count / total)
    })

    const result = {
        id: tool,
        total,
        buckets: results
    }

    const entity = getEntity(result)
    if (entity) {
        result.entity = entity
    }

    return result
}

export const computeToolsExperience = async (
    db: Db,
    survey: SurveyConfig,
    tools: string[],
    year: number
) => {
    const results = []
    for (const tool of tools) {
        results.push(await computeToolExperience(db, survey, tool, year))
    }

    return results
}
*/

const metrics = ['awareness', 'interest', 'satisfaction']

export async function computeToolsExperienceRanking(
    db: Db,
    survey: SurveyConfig,
    tools: string[],
    filters?: Filters
) {
    let availableYears: any[] = []
    const metricByYear: { [key: string]: any } = {}

    for (const tool of tools) {
        const toolAllYearsExperience = await computeExperienceOverYears(db, survey, tool, filters)
        const toolAwarenessInterestSatisfactionOverYears: any[] = []

        toolAllYearsExperience.forEach((toolYear: any) => {
            availableYears.push(toolYear.year)

            if (metricByYear[toolYear.year] === undefined) {
                metricByYear[toolYear.year] = {
                    awareness: [],
                    interest: [],
                    satisfaction: []
                }
            }

            metrics.forEach(metric => {
                metricByYear[toolYear.year][metric].push({
                    tool,
                    percentage: toolYear.awarenessInterestSatisfaction[metric]
                })
            })

            toolAwarenessInterestSatisfactionOverYears.push({
                year: toolYear.year,
                ...toolYear.awarenessInterestSatisfaction
            })
        })
    }

    for (const yearMetrics of Object.values(metricByYear)) {
        metrics.forEach(metric => {
            yearMetrics[metric] = _.sortBy(yearMetrics[metric], 'percentage').reverse()
            yearMetrics[metric].forEach((bucket: any, index: number) => {
                // make ranking starts at 1
                bucket.rank = index + 1
            })
        })
    }

    availableYears = _.uniq(availableYears).sort()

    const byTool: any[] = []
    tools.forEach(tool => {
        byTool.push({
            id: tool,
            entity: getEntity({ id: tool }),
            ...metrics.reduce((acc, metric) => {
                return {
                    ...acc,
                    [metric]: availableYears.map(year => {
                        const toolYearMetric = metricByYear[year][metric].find(
                            (d: any) => d.tool === tool
                        )
                        let rank = null
                        let percentage = null
                        if (toolYearMetric !== undefined) {
                            rank = toolYearMetric.rank
                            percentage = toolYearMetric.percentage
                        }

                        return { year, rank, percentage }
                    })
                }
            }, {})
        })
    })

    return byTool
}
