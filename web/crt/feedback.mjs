const row = (answer, unit, reason) => ({ answer, unit, reason });
export const PRACTICE_KEY = {
  p1: row(
    6,
    "km/h",
    "편도 12km면 갈 때 1시간, 올 때 3시간. 24km ÷ 4시간 = 6km/h",
  ),
  p2: row(5, "km/h", "양쪽 속력이 같아 전체 속력도 5km/h"),
  p3: row(4.5, "km/h", "같은 시간씩 이동하므로 (6 + 3) ÷ 2 = 4.5km/h"),
  p4: row(
    null,
    "",
    "느린 속력으로 걷는 시간이 더 길다. 편도 6km면 12km ÷ 3시간 = 4km/h",
  ),
};
export const FEEDBACK =
  "왕복 평균 속력은 총거리 ÷ 총시간입니다. 편도 6km면 갈 때 1시간, 돌아올 때 2시간으로 12km ÷ 3시간 = 4km/h입니다. 느린 속력으로 걷는 시간이 더 길어 단순 평균 4.5km/h와 다릅니다.";
export const ANCHORS = [
  {
    score: 2,
    text: "6km. 편도 12km면 갈 때 1시간, 올 때 3시간. 24km ÷ 4시간 = 6.",
  },
  { score: 1, text: "6km" },
  { score: 0, text: "8km. (12 + 4) ÷ 2" },
];
