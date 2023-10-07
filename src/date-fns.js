function startDate(year, month) {
  return new Date(year, month, 1, 0);
}

function endDate(year, month) {
  return new Date(year, month, 0, 24);
}

export function getMonthPeriods() {
  const date = new Date();
  const year = date.getFullYear();

  const periods = [];

  // Handle EOY, getMonth is zero-indexed:
  if (date.getMonth() == 0) {
    // Add the previous month (December):
    periods.push({
      start: startDate(year - 1, -1),
      end: endDate(year, 0),
    });
  } else {
    // Calculate & add the last 6 months
    //
    // Note: I'm not sure if this will work correctly at year
    // boundaries, but it seems to:
    for (let i = 6; i >= 0; i--) {
      periods.push({
        start: startDate(year, date.getMonth() - i - 1),
        end: endDate(year, date.getMonth() - i),
      });
    }
  }

  // Add the current month:
  periods.push({
    start: startDate(year, date.getMonth()),
    end: endDate(year, date.getMonth() + 1),
  });

  return periods;
}

export function formatDate(date, longDate) {
  return Intl.DateTimeFormat(
    "en-GB",
    longDate
      ? { dateStyle: "long" }
      : {
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
          hour: "numeric",
          minute: "numeric",
        }
  ).format(date);
}
export function formatPeriod(period, longDate) {
  return `${formatDate(period.start, !!longDate)} until ${formatDate(
    period.end,
    !!longDate
  )}`;
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
