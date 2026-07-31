/**
 * TalentCIO Backend Payroll Engine
 * Monolithic entry point refactored into modular sub-modules under ./payroll/ for maximum scalability.
 * Re-exports all functions and constants for 100% backward compatibility with existing controllers.
 */

const payrollEngine = require('./payroll');

module.exports = {
  ...payrollEngine,
};
