export const COUNTRIES = {
  ALL: {
    code: "ALL",
    name: "All",
    flag: "🌐",
    region: "AE",
    callingCode: "971",
    localMobilePrefix: "05",
    combined: true
  },
  AE: {
    code: "AE",
    name: "UAE",
    flag: "🇦🇪",
    region: "AE",
    callingCode: "971",
    localMobilePrefix: "05"
  },
  SA: {
    code: "SA",
    name: "Saudi Arabia",
    flag: "🇸🇦",
    region: "SA",
    callingCode: "966",
    localMobilePrefix: "05"
  }
};

export function countryFromCode(code) {
  return COUNTRIES[code] || COUNTRIES.AE;
}

export function countryTabs() {
  return Object.values(COUNTRIES);
}

export function isAllCountry(country) {
  return String(country || "").toUpperCase() === "ALL";
}
