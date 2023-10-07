const TAX_LAWS = {
  germany: {
    smallInvoiceLimit: 25000,
    smallBusinessStatement:
      "In accordance with Section 19 UStG, this invoice does not include VAT.",
  },
};

export function validateTaxLaw(config) {
  const country = config.business.country.toLowerCase();
  if (!TAX_LAWS.hasOwnProperty(country)) {
    console.error(
      `This tool currently only supports the following tax laws:\n${Object.keys(
        TAX_LAWS
      )
        .map((country) => ` - ${country}`)
        .join("\n")}\n`
    );

    process.exit(1);
  }
}

export function getTaxLaw(config) {
  const country = config.business.country.toLowerCase();
  return TAX_LAWS[country];
}
