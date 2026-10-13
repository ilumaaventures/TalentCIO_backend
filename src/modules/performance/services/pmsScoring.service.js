/**
 * PMS Scoring & Rating Engine
 * Pure math & calculation engine for normalized scores, weighted rollups, and rating bands.
 */

const DEFAULT_RATING_BANDS_5 = [
  { score: 5, label: 'Exceptional Performance', minPercent: 90, maxPercent: 100, color: '#10b981' },
  { score: 4, label: 'Exceeds Expectations', minPercent: 75, maxPercent: 89.99, color: '#3b82f6' },
  { score: 3, label: 'Meets Expectations', minPercent: 60, maxPercent: 74.99, color: '#6366f1' },
  { score: 2, label: 'Partially Meets Expectations', minPercent: 40, maxPercent: 59.99, color: '#f59e0b' },
  { score: 1, label: 'Significantly Below Expectations', minPercent: 0, maxPercent: 39.99, color: '#ef4444' },
];

/**
 * Calculates KPI achievement percentage & score
 * @param {Object} kpi
 * @returns {{ achievementPercent: number, calculatedScore: number }}
 */
function calculateKpiAchievement(kpi) {
  const target = Number(kpi?.targetValue || 0);
  const actual = Number(kpi?.actualValue || 0);
  const direction = kpi?.measurementDirection || 'higher_is_better';

  if (!target || target === 0) {
    return { achievementPercent: 0, calculatedScore: 0 };
  }

  let achievementPercent = 0;

  if (direction === 'higher_is_better') {
    achievementPercent = (actual / target) * 100;
  } else if (direction === 'lower_is_better') {
    // If target is 10 and actual is 5 -> 200% achievement; if target is 10 and actual is 20 -> 50%
    if (actual <= 0) {
      achievementPercent = 100;
    } else {
      achievementPercent = (target / actual) * 100;
    }
  } else if (direction === 'target_range') {
    const min = Number(kpi?.acceptableRangeMin ?? target * 0.9);
    const max = Number(kpi?.acceptableRangeMax ?? target * 1.1);
    if (actual >= min && actual <= max) {
      achievementPercent = 100;
    } else if (actual < min) {
      achievementPercent = min > 0 ? Math.max(0, (actual / min) * 100) : 0;
    } else {
      const over = actual - max;
      achievementPercent = Math.max(0, 100 - (over / max) * 100);
    }
  }

  // Cap at sensible limits (e.g., 0% to 150%)
  achievementPercent = Math.max(0, Math.min(150, Math.round(achievementPercent * 100) / 100));

  // Scaled 1-5 score for this KPI
  const calculatedScore = Math.max(1, Math.min(5, Math.round(((achievementPercent / 100) * 5) * 100) / 100));

  return {
    achievementPercent,
    calculatedScore,
  };
}

/**
 * Calculates weighted sum of an array of rated items
 * @param {Array<{ weightage?: number, rating?: number, score?: number }>} items
 * @param {number} scaleMax (default 5)
 * @returns {{ weightedScore: number, averageScore: number, normalizedPercent: number }}
 */
function calculateWeightedSectionScore(items = [], scaleMax = 5) {
  if (!items || items.length === 0) {
    return { weightedScore: 0, averageScore: 0, normalizedPercent: 0 };
  }

  let totalWeight = 0;
  let weightedSum = 0;
  let simpleSum = 0;
  let validCount = 0;

  items.forEach((item) => {
    const score = Number(item.rating ?? item.managerRating ?? item.selfRating ?? item.score ?? 0);
    const weight = Number(item.weightage || 0);

    if (score > 0) {
      validCount += 1;
      simpleSum += score;
      if (weight > 0) {
        totalWeight += weight;
        weightedSum += score * (weight / 100);
      }
    }
  });

  const averageScore = validCount > 0 ? Math.round((simpleSum / validCount) * 100) / 100 : 0;

  // If weights didn't sum to 100, normalize by total weight
  let finalWeighted = averageScore;
  if (totalWeight > 0) {
    finalWeighted = Math.round((weightedSum * (100 / totalWeight)) * 100) / 100;
  }

  const normalizedPercent = Math.round(((finalWeighted / scaleMax) * 100) * 100) / 100;

  return {
    weightedScore: finalWeighted,
    averageScore,
    normalizedPercent,
  };
}

/**
 * Maps a normalized percentage (0-100) to a rating band
 * @param {number} percentage
 * @param {Array} customBands
 * @returns {string} Rating band label
 */
function mapPercentToRatingBand(percentage, customBands = null) {
  const bands = customBands && customBands.length > 0 ? customBands : DEFAULT_RATING_BANDS_5;
  const sorted = [...bands].sort((a, b) => b.minPercent - a.minPercent);

  for (const band of sorted) {
    if (percentage >= band.minPercent) {
      return band.label;
    }
  }
  return sorted[sorted.length - 1]?.label || 'Needs Review';
}

/**
 * Calculates the overall consolidated performance score for an appraisal
 * @param {Object} params
 * @param {Object} params.appraisal
 * @param {Object} params.cycleSettings
 * @param {Array} params.customBands
 * @returns {Object} Full explainable calculation breakdown
 */
function computeConsolidatedAppraisalScore({ appraisal, cycleSettings = {}, customBands = null }) {
  const weights = cycleSettings?.weightageModel || {
    kraWeight: 40,
    kpiWeight: 20,
    goalWeight: 20,
    competencyWeight: 20,
  };

  const mgr = appraisal?.managerAppraisal || {};
  const kraResult = calculateWeightedSectionScore(mgr.kraRatings || []);
  const kpiResult = calculateWeightedSectionScore(mgr.kpiRatings || []);
  const goalResult = calculateWeightedSectionScore(mgr.goalRatings || []);
  const compResult = calculateWeightedSectionScore(mgr.competencyRatings || []);

  // Calculate peer score if available
  const peerList = appraisal?.peerReviews?.filter((p) => p.status === 'submitted') || [];
  let peerAvg = 0;
  if (peerList.length > 0) {
    let peerSum = 0;
    let peerRatingCount = 0;
    peerList.forEach((p) => {
      (p.ratings || []).forEach((r) => {
        if (r.rating > 0) {
          peerSum += r.rating;
          peerRatingCount += 1;
        }
      });
    });
    if (peerRatingCount > 0) peerAvg = Math.round((peerSum / peerRatingCount) * 100) / 100;
  }

  // Active section weights normalization
  const wKra = weights.kraWeight || 0;
  const wKpi = weights.kpiWeight || 0;
  const wGoal = weights.goalWeight || 0;
  const wComp = weights.competencyWeight || 0;
  const sumWeights = wKra + wKpi + wGoal + wComp || 100;

  // Weighted calculation (0 - 5 scale)
  const finalScoreRaw =
    (kraResult.weightedScore * wKra +
      kpiResult.weightedScore * wKpi +
      goalResult.weightedScore * wGoal +
      compResult.weightedScore * wComp) /
    sumWeights;

  const finalScore5 = Math.round(finalScoreRaw * 100) / 100;
  const normalizedScore = Math.max(0, Math.min(100, Math.round((finalScore5 / 5) * 10000) / 100));
  const ratingBand = mapPercentToRatingBand(normalizedScore, customBands);

  // Self score preview
  const self = appraisal?.selfAppraisal || {};
  const selfKra = calculateWeightedSectionScore(self.kraRatings || []);
  const selfKpi = calculateWeightedSectionScore(self.kpiRatings || []);
  const selfGoal = calculateWeightedSectionScore(self.goalRatings || []);
  const selfComp = calculateWeightedSectionScore(self.competencyRatings || []);
  const selfOverallScore =
    Math.round(
      ((selfKra.weightedScore * wKra +
        selfKpi.weightedScore * wKpi +
        selfGoal.weightedScore * wGoal +
        selfComp.weightedScore * wComp) /
        sumWeights) *
        100
    ) / 100;

  return {
    rawKraScore: kraResult.weightedScore,
    rawKpiScore: kpiResult.weightedScore,
    rawGoalScore: goalResult.weightedScore,
    rawCompetencyScore: compResult.weightedScore,
    rawPeerScore: peerAvg,
    selfOverallScore,
    managerOverallScore: finalScore5,
    calculatedFinalScore: finalScore5,
    normalizedScore,
    ratingBand,
    scoreBreakdown: {
      sections: {
        kra: { score: kraResult.weightedScore, weight: wKra, percent: kraResult.normalizedPercent },
        kpi: { score: kpiResult.weightedScore, weight: wKpi, percent: kpiResult.normalizedPercent },
        goals: { score: goalResult.weightedScore, weight: wGoal, percent: goalResult.normalizedPercent },
        competencies: { score: compResult.weightedScore, weight: wComp, percent: compResult.normalizedPercent },
        peer: { score: peerAvg, count: peerList.length },
      },
      formula: `(KRA*${wKra} + KPI*${wKpi} + Goals*${wGoal} + Competencies*${wComp}) / ${sumWeights}`,
      calculatedAt: new Date(),
    },
  };
}

module.exports = {
  DEFAULT_RATING_BANDS_5,
  calculateKpiAchievement,
  calculateWeightedSectionScore,
  mapPercentToRatingBand,
  computeConsolidatedAppraisalScore,
};
