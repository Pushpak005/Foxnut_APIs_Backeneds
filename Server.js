import express from "express";
import fetch from "node-fetch";
import cors from "cors";

const app = express();
app.use(cors());

const PORT = process.env.PORT || 3000;

// Example: healthy food recommender for Bangalore
app.get("/recommend", async (req, res) => {
  const calories = req.query.calories || 500;
  const activity = req.query.activity || "moderate";
  const taste = req.query.taste || "balanced";

  // Swiggy/Zomato search terms (you could replace with scraping later)
  const searchTerms = [
    "healthy salad",
    "grilled chicken",
    "low calorie wrap",
    "protein bowl"
  ];

  const results = searchTerms.map((term) => ({
    name: term,
    link: `https://www.google.com/search?q=${encodeURIComponent(
      term + " site:swiggy.com bangalore OR site:zomato.com bangalore"
    )}`,
    reason: `Matches your ${activity} activity and ~${calories} kcal target.`,
    source: "Prototype nutrition rules"
  }));

  res.json({
    userTarget: { calories, activity, taste },
    picks: results
  });
});

app.listen(PORT, () => {
  console.log(`Healthy recommender API running on port ${PORT}`);
});
