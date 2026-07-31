/**
 * professionalTaxSlabs.js
 * Legacy alias module. Re-exports professional tax functions and slabs from ./payroll/statutoryEngine.
 * Eliminates duplicate slab definitions across backend modules.
 */

module.exports = require('./payroll/statutoryEngine');
