function recoveryStatus() {
  return {
    missingContext: "classified",
    staleDocs: "conflict",
    validationStrategy: "repaired",
    workspacePollution: "cleaned",
    authorityPause: "documented",
    resume: "scripted"
  };
}

module.exports = { recoveryStatus };
