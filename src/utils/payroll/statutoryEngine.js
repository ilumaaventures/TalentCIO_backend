const { roundAmount } = require('./prorationUtils');

const computeStatutoryComponents = ({ pfEnabled, gratuityEnabled, lwfEnabled, monthlyCTC, basicMaster, config, includePfInCTC, includeGratuityInCTC }) => {
  let pfEmployer = 0;
  let pfEmployee = 0;
  let pfBase = 0;

  if (pfEnabled && basicMaster > 0 && monthlyCTC > 0) {
    if (config.pfCalculationType === 'fixed') {
      pfEmployer = roundAmount(config.pfAmountEmployer);
      pfEmployee = roundAmount(config.pfAmountEmployee);
      pfBase = pfEmployee;
    } else {
      pfBase = roundAmount(Math.min(basicMaster, config.pfCap));
      pfEmployer = roundAmount(pfBase * config.pfEmployerRate);
      pfEmployee = roundAmount(pfBase * config.pfRate);
    }
  }

  const gratuity = gratuityEnabled ? roundAmount(basicMaster * config.gratuityRate) : 0;
  const lwfEmployer = (lwfEnabled && monthlyCTC > 0) ? roundAmount(config.lwfEmployer) : 0;
  const lwfEmployee = (lwfEnabled && monthlyCTC > 0) ? roundAmount(config.lwfEmployee) : 0;

  return {
    pfEmployer,
    pfEmployee,
    pfBase,
    gratuity,
    lwfEmployer,
    lwfEmployee,
    pfEmployerInCTC: (pfEnabled && includePfInCTC) ? pfEmployer : 0,
    gratuityInCTC: (gratuityEnabled && includeGratuityInCTC) ? gratuity : 0,
  };
};

module.exports = {
  computeStatutoryComponents,
};
