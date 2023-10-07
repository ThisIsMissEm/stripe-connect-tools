import convict from "convict";
import convictFormatValidators from "convict-format-with-validator";
import { parse } from "@iarna/toml";
import { join, dirname } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = join(dirname(__filename), "..");

convict.addParser({ extension: "toml", parse });
convict.addFormats(convictFormatValidators);

const config = convict({
  business: {
    name: {
      doc: "Name of the business (e.g., your name as a freelancer)",
      format: String,
      default: "",
    },
    email: {
      doc: "Email address for the business",
      format: "email",
      default: "",
    },
    website: {
      doc: "Website address for the business",
      format: function check(val) {
        try {
          val && new URL(val);
          return true;
        } catch (err) {
          throw new TypeError(`business.website is not a valid URL`);
        }
      },
      default: "",
    },
    address_line_1: {
      doc: "Address line 1",
      format: String,
      default: "",
    },
    address_line_2: {
      doc: "Address line 2",
      format: String,
      default: "",
    },
    postal_code: {
      doc: "Business postal code",
      format: String,
      default: "",
    },
    city: {
      doc: "City",
      format: String,
      default: "",
    },
    state: {
      doc: "State",
      format: String,
      default: "",
    },
    country: {
      doc: "Country",
      format: String,
      default: "",
    },
    tax_identifier: {
      doc: "Tax Identifier",
      format: String,
      default: "",
    },
  },
  receipts: {
    dateFormat: {
      doc: "Format for the dates on receipts, as a BCP 47 language tag",
      format: String,
      default: "en-GB",
    },
  },
});
const configFile = join(__dirname, "config.toml");

if (existsSync(configFile)) {
  config.loadFile(configFile);
} else {
  console.error(`Missing config.toml file in ${__dirname}`);
  console.error(
    "Please create this file based on the example.config.toml file"
  );
  process.exit(1);
}

config.validate({ allowed: "strict" });

export default config;
