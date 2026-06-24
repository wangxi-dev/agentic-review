using System;

namespace AgenticReview.Examples
{
    // Sample C# file to exercise the code renderer.
    public record Point(double X, double Y)
    {
        public double DistanceTo(Point other)
        {
            var dx = X - other.X;
            var dy = Y - other.Y;
            return Math.Sqrt(dx * dx + dy * dy);
        }
    }

    public static class Program
    {
        public static void Main()
        {
            var a = new Point(0, 0);
            var b = new Point(3, 4);
            Console.WriteLine($"distance: {a.DistanceTo(b)}");
        }
    }
}
