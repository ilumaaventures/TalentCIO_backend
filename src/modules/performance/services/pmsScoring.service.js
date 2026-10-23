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
 * Handles Boolean KPIs, zero-target lower-is-better vs higher-is-better, and validates inputs.
 * @param {Object} kpi
 * @returns {{ achievementPercent: number|null, calculatedScore: number|null, isValid: boolean, isBoolean?: boolean, reason?: string }}
 */
function calculateKpiAchievement(kpi) {
  if (!kpi || typeof kpi !== 'object') {
    return { achievementPercent: null, calculatedScore: null, isValid: false, reason: 'Missing KPI data' };
  }

  const measurementType = kpi.measurementType || 'numeric';
  const direction = kpi.measurementDirection || 'higher_is_better';

  // Handle Boolean / Yes-No KPIs
  if (measurementType === 'yes_no') {
    const rawActual = kpi.actualValue;
    if (rawActual === undefined || rawActual === null || rawActual === '') {
      return { achievementPercent: null, calculatedScore: null, isValid: false, reason: 'Actual value not provided for Boolean KPI' };
    }
    const isAchieved =
      rawActual === true ||
      rawActual === 1 ||
      String(rawActual).trim().toLowerCase() === 'yes' ||
      String(rawActual).trim().toLowerCase() === 'true' ||
      String(rawActual).trim() === '1';

    const achievementPercent = isAchieved ? 100 : 0;
    const calculatedScore = isAchieved ? 5 : 1;
    return {
      achievementPercent,
      calculatedScore,
      isValid: true,
      isBoolean: true,
    };
  }

  const target = kpi.targetValue !== undefined && kpi.targetValue !== null ? Number(kpi.targetValue) : null;
  const actual = kpi.actualValue !== undefined && kpi.actualValue !== null ? Number(kpi.actualValue) : null;

  if (target === null || isNaN(target)) {
    return { achievementPercent: null, calculatedScore: null, isValid: false, reason: 'Target value is invalid or missing' };
  }

  if (actual === null || isNaN(actual)) {
    return { achievementPercent: null, calculatedScore: null, isValid: false, reason: 'Actual value is invalid or missing' };
  }

  // Handle zero-target
  if (target === 0) {
    if (direction === 'lower_is_better') {
      // 0 defects/downtime target: 0 actual is 100% achievement (score 5), >0 is 0% achievement (score 1)
      const achievementPercent = actual <= 0 ? 100 : 0;
      const calculatedScore = actual <= 0 ? 5 : 1;
      return { achievementPercent, calculatedScore, isValid: true };
    }
    // For higher_is_better or target_range, a target of 0 has no meaningful target
    // Do not blindly assign a minimum score of 1 when the KPI is invalid or has no meaningful target
    return {
      achievementPercent: null,
      calculatedScore: null,
      isValid: false,
      reason: 'Zero target is invalid for higher_is_better or range-based measurement',
    };
  }

  if (target < 0) {
    return { achievementPercent: null, calculatedScore: null, isValid: false, reason: 'Target cannot be negative' };
  }

  let achievementPercent = 0;

  if (direction === 'higher_is_better') {
    achievementPercent = (actual / target) * 100;
  } else if (direction === 'lower_is_better') {
    if (actual <= 0) {
      achievementPercent = 100;
    } else {
      achievementPercent = (target / actual) * 100;
    }
  } else if (direction === 'target_range') {
    const min = Number(kpi.acceptableRangeMin ?? target * 0.9);
    const max = Number(kpi.acceptableRangeMax ?? target * 1.1);
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
    isValid: true,
  };
}

/**
 * Calculates weighted sum of an array of rated items
 * Distinguishes unassigned sections from assigned sections with missing ratings.
 * @param {Array<{ weightage?: number, rating?: number, managerRating?: number, selfRating?: number, score?: number }>} items
 * @param {number} scaleMax (default 5)
 * @returns {{ hasItems: boolean, itemCount: number, ratedCount: number, isComplete: boolean, missingRatingsCount: number, weightedScore: number, averageScore: number, normalizedPercent: number }}
 */
function calculateWeightedSectionScore(items = [], scaleMax = 5) {
  if (!Array.isArray(items) || items.length === 0) {
    return {
      hasItems: false,
      itemCount: 0,
      ratedCount: 0,
      isComplete: true,
      missingRatingsCount: 0,
      weightedScore: 0,
      averageScore: 0,
      normalizedPercent: 0,
    };
  }

  let totalWeight = 0;
  let weightedSum = 0;
  let simpleSum = 0;
  let validCount = 0;

  items.forEach((item) => {
    const rawScore = item?.rating ?? item?.managerRating ?? item?.selfRating ?? item?.score;
    const score = Number(rawScore || 0);
    const weight = Number(item?.weightage || 0);

    if (score > 0) {
      validCount += 1;
      simpleSum += score;
      if (weight > 0) {
        totalWeight += weight;
        weightedSum += score * (weight / 100);
      }
    }
  });

  const isComplete = validCount === items.length;
  const averageScore = validCount > 0 ? Math.round((simpleSum / validCount) * 100) / 100 : 0;

  let finalWeighted = averageScore;
  if (totalWeight > 0) {
    finalWeighted = Math.round((weightedSum * (100 / totalWeight)) * 100) / 100;
  }

  const normalizedPercent = Math.round(((finalWeighted / scaleMax) * 100) * 100) / 100;

  return {
    hasItems: true,
    itemCount: items.length,
    ratedCount: validCount,
    isComplete,
    missingRatingsCount: items.length - validCount,
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
 * Normalizes dynamically only across sections that have assigned items.
 * If assigned items are missing required ratings, marks appraisal incomplete.
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

  // Check completeness: if a section has items, all items must be rated
  const incompleteSections = [];
  if (kraResult.hasItems && !kraResult.isComplete) incompleteSections.push('KRA');
  if (kpiResult.hasItems && !kpiResult.isComplete) incompleteSections.push('KPI');
  if (goalResult.hasItems && !goalResult.isComplete) incompleteSections.push('Goals');
  if (compResult.hasItems && !compResult.isComplete) incompleteSections.push('Competencies');

  const isIncomplete = incompleteSections.length > 0;
  const incompleteReason = isIncomplete
    ? `Required ratings are missing for assigned items in: ${incompleteSections.join(', ')}`
    : null;

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

  // Active section weights dynamic normalization (only include sections that have assigned items)
  const wKra = weights.kraWeight || 0;
  const wKpi = weights.kpiWeight || 0;
  const wGoal = weights.goalWeight || 0;
  const wComp = weights.competencyWeight || 0;

  const activeSumWeights =
    (kraResult.hasItems ? wKra : 0) +
    (kpiResult.hasItems ? wKpi : 0) +
    (goalResult.hasItems ? wGoal : 0) +
    (compResult.hasItems ? wComp : 0);

  let finalScore5 = null;
  let normalizedScore = null;
  let ratingBand = 'No Assigned Items';

  if (isIncomplete) {
    ratingBand = 'Incomplete / Pending Evaluation';
  } else if (activeSumWeights === 0) {
    finalScore5 = 0;
    normalizedScore = 0;
    ratingBand = 'No Assigned Items';
  } else {
    // Weighted calculation normalized by active sections
    const weightedSum =
      (kraResult.hasItems ? kraResult.weightedScore * wKra : 0) +
      (kpiResult.hasItems ? kpiResult.weightedScore * wKpi : 0) +
      (goalResult.hasItems ? goalResult.weightedScore * wGoal : 0) +
      (compResult.hasItems ? compResult.weightedScore * wComp : 0);

    const finalScoreRaw = weightedSum / activeSumWeights;
    finalScore5 = Math.round(finalScoreRaw * 100) / 100;
    normalizedScore = Math.max(0, Math.min(100, Math.round((finalScore5 / 5) * 10000) / 100));
    ratingBand = mapPercentToRatingBand(normalizedScore, customBands);
  }

  // Self score preview
  const self = appraisal?.selfAppraisal || {};
  const selfKra = calculateWeightedSectionScore(self.kraRatings || []);
  const selfKpi = calculateWeightedSectionScore(self.kpiRatings || []);
  const selfGoal = calculateWeightedSectionScore(self.goalRatings || []);
  const selfComp = calculateWeightedSectionScore(self.competencyRatings || []);

  const selfActiveSumWeights =
    (selfKra.hasItems ? wKra : 0) +
    (selfKpi.hasItems ? wKpi : 0) +
    (selfGoal.hasItems ? wGoal : 0) +
    (selfComp.hasItems ? wComp : 0);

  const selfIncomplete =
    (selfKra.hasItems && !selfKra.isComplete) ||
    (selfKpi.hasItems && !selfKpi.isComplete) ||
    (selfGoal.hasItems && !selfGoal.isComplete) ||
    (selfComp.hasItems && !selfComp.isComplete);

  let selfOverallScore = null;
  if (!selfIncomplete && selfActiveSumWeights > 0) {
    const selfRaw =
      ((selfKra.hasItems ? selfKra.weightedScore * wKra : 0) +
        (selfKpi.hasItems ? selfKpi.weightedScore * wKpi : 0) +
        (selfGoal.hasItems ? selfGoal.weightedScore * wGoal : 0) +
        (selfComp.hasItems ? selfComp.weightedScore * wComp : 0)) /
      selfActiveSumWeights;
    selfOverallScore = Math.round(selfRaw * 100) / 100;
  }

  const formulaParts = [];
  if (kraResult.hasItems) formulaParts.push(`KRA*${wKra}`);
  if (kpiResult.hasItems) formulaParts.push(`KPI*${wKpi}`);
  if (goalResult.hasItems) formulaParts.push(`Goals*${wGoal}`);
  if (compResult.hasItems) formulaParts.push(`Competencies*${wComp}`);

  return {
    isIncomplete,
    incompleteReason,
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
        kra: { score: kraResult.weightedScore, weight: wKra, percent: kraResult.normalizedPercent, hasItems: kraResult.hasItems, isComplete: kraResult.isComplete, ratedCount: kraResult.ratedCount, itemCount: kraResult.itemCount },
        kpi: { score: kpiResult.weightedScore, weight: wKpi, percent: kpiResult.normalizedPercent, hasItems: kpiResult.hasItems, isComplete: kpiResult.isComplete, ratedCount: kpiResult.ratedCount, itemCount: kpiResult.itemCount },
        goals: { score: goalResult.weightedScore, weight: wGoal, percent: goalResult.normalizedPercent, hasItems: goalResult.hasItems, isComplete: goalResult.isComplete, ratedCount: goalResult.ratedCount, itemCount: goalResult.itemCount },
        competencies: { score: compResult.weightedScore, weight: wComp, percent: compResult.normalizedPercent, hasItems: compResult.hasItems, isComplete: compResult.isComplete, ratedCount: compResult.ratedCount, itemCount: compResult.itemCount },
        peer: { score: peerAvg, count: peerList.length },
      },
      activeWeights: {
        kra: kraResult.hasItems ? wKra : 0,
        kpi: kpiResult.hasItems ? wKpi : 0,
        goals: goalResult.hasItems ? wGoal : 0,
        competencies: compResult.hasItems ? wComp : 0,
      },
      activeSumWeights,
      formula: activeSumWeights > 0 ? `(${formulaParts.join(' + ')}) / ${activeSumWeights}` : 'N/A',
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

