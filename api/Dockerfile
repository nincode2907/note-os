FROM php:8.4-cli
COPY --from=composer:2 /usr/bin/composer /usr/bin/composer
RUN apt-get update && apt-get install -y --no-install-recommends unzip libzip-dev && rm -rf /var/lib/apt/lists/* \
    && docker-php-ext-install pdo_mysql zip
WORKDIR /var/www/html
COPY composer.json composer.lock ./
RUN composer install --no-dev --no-interaction --prefer-dist --optimize-autoloader --no-scripts
COPY . .
RUN composer dump-autoload --no-dev --optimize --no-scripts && php artisan package:discover
EXPOSE 15001
