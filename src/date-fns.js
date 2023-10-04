export function toYYYYMMDDString(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(
    2,
    "0"
  )}-${String(date.getDate()).padStart(2, "0")}`;
}

export function getMonthPeriods() {
  const date = new Date();
  const year = date.getFullYear();

  const periods = [];

  // Handle EOY, getMonth is zero-indexed:
  if (date.getMonth() == 0) {
    // Add the previous month (December):
    periods.push({
      start: new Date(year, 0, 1),
      end: new Date(year, 0, 0),
    });
  } else {
    for (let i = 6; i > 0; i--) {
      periods.push({
        start: new Date(year, date.getMonth() - i - 1, 1),
        end: new Date(year, date.getMonth() - i, 0),
      });
    }

    // Add the current month:
    periods.push({
      start: new Date(year, date.getMonth() - 1, 1),
      end: new Date(year, date.getMonth(), 0),
    });
  }

  // Add the current month:
  periods.push({
    start: new Date(year, date.getMonth(), 1),
    end: new Date(year, date.getMonth() + 1, 0),
  });

  return periods;
}

export function formatPeriod(period) {
  return `${Intl.DateTimeFormat("en-GB").format(
    period.start
  )} to ${Intl.DateTimeFormat("en-GB").format(period.end)}`;
}

export function getMonthChoices() {
  const periods = getMonthPeriods();

  return periods.map((period) => ({
    title: formatPeriod(period),
    value: period,
  }));
}

// validate: (value) => {
//   const parts = value.split("-");
//   if (parts.length !== 3) return false;

//   if (!/20[0-9]{2}/.test(parts[0])) {
//     return false;
//   }

//   const monthPart = parseInt(parts[1], 0);
//   if (monthPart <= 0 || monthPart > 12) {
//     return false;
//   }

//   const dayPart = parseInt(parts[2], 0);
//   if (dayPart <= 0 || dayPart > 31) {
//     return false;
//   }

//   return true;
// },
