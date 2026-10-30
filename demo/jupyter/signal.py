#:: lumine-demo
# Inspect a real built-in sequence without a tool-installation file path.

samples = [0.2, 0.8, -0.4, 0.5, 1.0]
mean = sum(samples) / len(samples)
peak = max(abs(sample) for sample in samples)

print(f"Mean amplitude: {mean:.2f}")
print(f"Peak amplitude: {peak:.2f}")
samples
